/// <reference types="node" />

import * as http from "http";
import { randomUUID } from "crypto";
import { OpenClawRuntime } from "../runtime";

interface FeishuEventBody {
  type?: string;
  challenge?: string;
  encrypt?: string;
  header?: {
    event_type?: string;
  };
  event?: {
    message?: {
      message_type?: string;
      content?: string;
    };
    sender?: {
      sender_type?: string;
      sender_id?: {
        open_id?: string;
      };
    };
  };
}

class SmallTalkModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmallTalkModelError";
  }
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

const FEISHU_APP_ID = readEnv("FEISHU_APP_ID") ?? "";
const FEISHU_APP_SECRET = readEnv("FEISHU_APP_SECRET") ?? "";
const FEISHU_GATEWAY_HOST = readEnv("FEISHU_GATEWAY_HOST") ?? "0.0.0.0";
const FEISHU_GATEWAY_PORT = Number(readEnv("FEISHU_GATEWAY_PORT") ?? "9090");
const SMALL_TALK_MODEL_CHAT_URL = readEnv("SMALL_TALK_MODEL_CHAT_URL")
  ?? buildChatUrl(readEnv("SMALL_TALK_MODEL_BASE_URL") ?? readEnv("AGENT_LLM_BASE_URL") ?? "http://127.0.0.1:8080/apis/ais-v2");
const SMALL_TALK_MODEL_NAME = readEnv("SMALL_TALK_MODEL_NAME") ?? readEnv("AGENT_LLM_MODEL") ?? "qwen3-1.7b-instruct";
const SMALL_TALK_MODEL_API_KEY = readEnv("SMALL_TALK_MODEL_API_KEY") ?? readEnv("AGENT_LLM_API_KEY") ?? "";
const SMALL_TALK_MODEL_TIMEOUT_MS = Number(readEnv("SMALL_TALK_MODEL_TIMEOUT_MS") ?? "12000");

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  // eslint-disable-next-line no-console
  console.warn("[feishu-gateway] FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，回复飞书消息将失败");
}

const runtime = new OpenClawRuntime();

let tenantTokenCache: { token: string; expireAtMs: number } | null = null;

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "openclaw-feishu-gateway",
      host: FEISHU_GATEWAY_HOST,
      port: FEISHU_GATEWAY_PORT,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/feishu/events") {
    try {
      const body = await readJsonBody(req);

      // URL verification for event subscription
      if (body.type === "url_verification" && typeof body.challenge === "string") {
        sendJson(res, 200, { challenge: body.challenge });
        return;
      }

      // Feishu encryption can be enabled later; current minimal mode expects plaintext event payload.
      if (typeof body.encrypt === "string") {
        sendJson(res, 200, { ok: true, ignored: "encrypted_payload_not_supported_in_minimal_mode" });
        return;
      }

      const eventType = body.header?.event_type;
      if (eventType !== "im.message.receive_v1") {
        sendJson(res, 200, { ok: true, ignored: `unsupported_event:${String(eventType ?? "unknown")}` });
        return;
      }

      const event = body.event ?? {};
      const message = event.message ?? {};
      const sender = event.sender ?? {};
      const senderOpenId = sender.sender_id?.open_id as string | undefined;

      if (!senderOpenId) {
        sendJson(res, 200, { ok: true, ignored: "missing_sender_open_id" });
        return;
      }

      if (sender.sender_type && sender.sender_type !== "user") {
        sendJson(res, 200, { ok: true, ignored: `sender_type:${String(sender.sender_type)}` });
        return;
      }

      const messageType = String(message.message_type ?? "");
      if (messageType !== "text") {
        await sendFeishuTextMessage(senderOpenId, "当前仅支持文本指令，请发送文本消息。");
        sendJson(res, 200, { ok: true, ignored: `message_type:${messageType}` });
        return;
      }

      const instruction = parseFeishuTextContent(String(message.content ?? ""));
      if (!instruction) {
        await sendFeishuTextMessage(senderOpenId, "未识别到有效文本指令，请直接输入任务描述。");
        sendJson(res, 200, { ok: true, ignored: "empty_instruction" });
        return;
      }

      if (isCasualChat(instruction)) {
        try {
          const reply = await generateCasualReplyBySmallModel(instruction);
          await sendFeishuTextMessage(senderOpenId, reply);
          sendJson(res, 200, { ok: true, mode: "small_talk" });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await sendFeishuTextMessage(senderOpenId, `闲聊回复失败：${message}`);
          sendJson(res, 502, { ok: false, error: "small_talk_model_error", message });
          return;
        }
      }

      const taskId = `feishu-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const selectedExperts = selectExpertsByInstruction(instruction);
      const collaborationEdges = buildDefaultEdges(selectedExperts);

      const result = await runtime.execute({
        taskId,
        bossInstruction: instruction,
        small_model: { tier: "L2" },
        selected_experts: selectedExperts,
        collaboration_plan: { edges: collaborationEdges },
        info_pool_hits: [],
        output_attribution: { source: "feishu-gateway" },
        runtime_trace: { source: "feishu-gateway" },
      });

      const replyText = buildReplyText(result);
      await sendFeishuTextMessage(senderOpenId, replyText);

      sendJson(res, 200, {
        ok: true,
        taskId,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      });
      return;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[feishu-gateway] failed to process event", error);
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: "not_found",
    available: ["GET /health", "POST /feishu/events"],
  });
});

server.listen(FEISHU_GATEWAY_PORT, FEISHU_GATEWAY_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[feishu-gateway] listening on http://${FEISHU_GATEWAY_HOST}:${FEISHU_GATEWAY_PORT}`);
  // eslint-disable-next-line no-console
  console.log("[feishu-gateway] event path: POST /feishu/events");
});

function parseFeishuTextContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    if (typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    // Ignore and fallback to raw text.
  }

  return rawContent.trim();
}

function selectExpertsByInstruction(instruction: string): Array<{ name: string }> {
  const text = instruction.toLowerCase();
  const experts = [
    { name: "research_agent" },
    { name: "strategy_agent" },
    { name: "legal_agent" },
  ];

  if (/销售|转化|客户|咨询|follow\s*up|crm|sales/.test(text)) {
    experts.push({ name: "sales_agent" });
  }

  // Include market only when explicitly requested, avoiding unnecessary long-running browser actions by default.
  if (/市场|营销|推广|视频|投放|brand|market/.test(text)) {
    experts.push({ name: "market_agent" });
  }

  return experts;
}

function buildDefaultEdges(experts: Array<{ name: string }>): Array<{ from: string; to: string }> {
  const names = new Set(experts.map((item) => item.name));
  const edges: Array<{ from: string; to: string }> = [];

  if (names.has("research_agent") && names.has("strategy_agent")) {
    edges.push({ from: "research_agent", to: "strategy_agent" });
  }
  if (names.has("research_agent") && names.has("legal_agent")) {
    edges.push({ from: "research_agent", to: "legal_agent" });
  }
  if (names.has("strategy_agent") && names.has("market_agent")) {
    edges.push({ from: "strategy_agent", to: "market_agent" });
  }
  if (names.has("legal_agent") && names.has("market_agent")) {
    edges.push({ from: "legal_agent", to: "market_agent" });
  }
  if (names.has("market_agent") && names.has("sales_agent")) {
    edges.push({ from: "market_agent", to: "sales_agent" });
  }

  return edges;
}

function buildReplyText(result: {
  bossInstruction?: string;
  taskId: string;
  executiveSummary: {
    headline: string;
    overview: string;
    nextStep: string;
    warnings: string[];
    highlights?: string[];
    businessValue?: string;
    riskView?: string;
    priorityOrder?: string[];
    qualityScore?: number;
    feasibilityScore?: number;
    feasibilityVerdict?: string;
    businessValueRating?: string;
    riskLevel?: string;
  };
  succeeded: string[];
  failed: string[];
  qualityAssessment: { overallScore: number; overallGrade: string };
  fusedResult?: {
    type?: string;
    fusedContent?: string;
    confidence?: number;
    fusionMethod?: string;
    rankedCandidates?: Array<{
      department?: string;
      totalScore?: number;
      content?: string;
    }>;
  } | null;
}): string {
  const summary = result.executiveSummary;
  const overview = trimTrailingPunctuation(summary?.overview ?? "");
  const nextStep = trimTrailingPunctuation(summary?.nextStep ?? "");
  const warnings = (summary?.warnings ?? []).filter((item) => typeof item === "string" && item.trim().length > 0);
  const fused = normalizeFusionText(result.fusedResult?.fusedContent);
  const topRankedContent = normalizeFusionText(result.fusedResult?.rankedCandidates?.[0]?.content);

  const lines: string[] = [];
  if (fused) {
    lines.push(fused);
  } else if (topRankedContent) {
    lines.push(topRankedContent);
  } else {
    lines.push(overview || `任务 ${result.taskId} 已完成执行。`);
  }

  lines.push(`执行结果：成功 ${result.succeeded.length} 个部门，失败 ${result.failed.length} 个。`);

  if (nextStep) {
    lines.push(`下一步建议：${nextStep}。`);
  }

  if (warnings.length > 0) {
    lines.push(`风险提示：${warnings.join("；")}。`);
  }

  return lines.join("\n");
}

function trimTrailingPunctuation(text: string): string {
  return text.trim().replace(/[。.!！?？\s]+$/g, "");
}

function normalizeFusionText(text: string | undefined): string {
  if (!text) {
    return "";
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^融合结果（本地回退）/.test(line))
    .filter((line) => !/^架构：/.test(line))
    .filter((line) => !/^策略：/.test(line))
    .filter((line) => !/^提示：/.test(line))
    .filter((line) => !/^顶部候选：/.test(line))
    .filter((line) => !/^##\s*\d+\./.test(line))
    .filter((line) => !/^-\s*(total|base|pair|wins):/i.test(line));

  return lines
    .join("\n")
    .replace(/百度检索执行失败|检索失败|调用超时|接口错误/g, "外部实时数据待补充")
    .replace(/待模型补全/g, "待补充")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isCasualChat(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) {
    return false;
  }

  return /^(你好|您好|hi|hello|hey|在吗|在不在|哈喽|嗨|早上好|中午好|下午好|晚上好|yo|你能干什么|你会什么|你可以做什么|介绍下你自己|你是谁|help|帮助)[!！,.，。\s?？]*$/.test(text);
}

async function generateCasualReplyBySmallModel(input: string): Promise<string> {
  const timeoutMs = Number.isFinite(SMALL_TALK_MODEL_TIMEOUT_MS) && SMALL_TALK_MODEL_TIMEOUT_MS > 0
    ? SMALL_TALK_MODEL_TIMEOUT_MS
    : 12000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (SMALL_TALK_MODEL_API_KEY.trim().length > 0) {
      headers.Authorization = `Bearer ${SMALL_TALK_MODEL_API_KEY.trim()}`;
    }

    const response = await fetch(SMALL_TALK_MODEL_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: SMALL_TALK_MODEL_NAME,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content: "你是创业执行框架里的轻量助手。面对寒暄和功能咨询，使用自然、简短、有人味的中文回复。不要输出JSON，不要模板腔，不要提及内部路由/部门。",
          },
          {
            role: "user",
            content: input,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new SmallTalkModelError(`闲聊小模型调用失败: http=${response.status}, body=${body.slice(0, 200)}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text ?? "" : ""))
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }

    throw new SmallTalkModelError("闲聊小模型返回为空，无法生成回复。");
  } catch (error) {
    if (error instanceof SmallTalkModelError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new SmallTalkModelError(`闲聊小模型响应超时（>${timeoutMs}ms）。`);
    }
    throw new SmallTalkModelError(`闲聊小模型异常: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function buildChatUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

async function sendFeishuTextMessage(receiverOpenId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken();

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: receiverOpenId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid: randomUUID().slice(0, 50),
      }),
    },
  );

  const payload = await response.json() as { code?: number; msg?: string };
  if (!response.ok || payload.code !== 0) {
    throw new Error(`send feishu message failed: http=${response.status}, code=${String(payload.code)}, msg=${String(payload.msg)}`);
  }
}

async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (tenantTokenCache && tenantTokenCache.expireAtMs > now + (5 * 60 * 1000)) {
    return tenantTokenCache.token;
  }

  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET is missing");
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }),
    },
  );

  const data = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`get tenant_access_token failed: http=${response.status}, code=${String(data.code)}, msg=${String(data.msg)}`);
  }

  const expireSeconds = Number.isFinite(data.expire) ? Number(data.expire) : 7200;
  tenantTokenCache = {
    token: data.tenant_access_token,
    expireAtMs: Date.now() + (expireSeconds * 1000),
  };

  return tenantTokenCache.token;
}

function readJsonBody(req: http.IncomingMessage): Promise<FeishuEventBody> {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw) as FeishuEventBody);
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
