/// <reference types="node" />

import * as http from "http";
import * as fs from "fs";
import { randomUUID } from "crypto";
import * as path from "path";
import { OpenClawRuntime } from "../runtime";

type ExecuteRequestBody = {
  input?: unknown;
  openId?: unknown;
};

type CollaborationEdge = {
  from: string;
  to: string;
};

type IntentDecision = {
  intent: "business_request" | "casual_chat";
  confidence: number;
  reason: string;
  casualReply: string;
};

const AGENT_ORDER: Record<string, number> = {
  research_agent: 1,
  strategy_agent: 2,
  legal_agent: 3,
  market_agent: 4,
  sales_agent: 5,
};

type OpcRouteResponse = {
  ok?: boolean;
  small_model?: {
    tier?: string;
    score?: number;
    backend?: string;
    backend_reason?: string;
  };
  selected_experts?: Array<Record<string, unknown>>;
  collaboration_plan?: {
    edges?: Array<{ from?: string; to?: string }>;
  };
  info_pool_hits?: Array<Record<string, unknown>>;
  output_attribution?: Record<string, unknown>;
  runtime_trace?: Record<string, unknown>;
  message?: string;
};

class OpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpcUnavailableError";
  }
}

class SmallTalkModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmallTalkModelError";
  }
}

loadDotEnv();

const RUNTIME_HOST = process.env.RUNTIME_HOST ?? "0.0.0.0";
const RUNTIME_PORT = Number(process.env.RUNTIME_PORT ?? "30000");
const OPC_ROUTER_URL = process.env.OPC_ROUTER_URL ?? "http://127.0.0.1:18080/route";
// 默认 60s，包含本地小模型路由 + 可选 LLM 摘要，30s 在 LLM 慢响应时会超时
const OPC_ROUTER_TIMEOUT_MS = Number(process.env.OPC_ROUTER_TIMEOUT_MS ?? "60000");
const OPC_ROUTER_TRY_REMOTE_LLM = String(process.env.OPC_ROUTER_TRY_REMOTE_LLM ?? "true").toLowerCase() === "true";
const SMALL_TALK_MODEL_CHAT_URL = process.env.SMALL_TALK_MODEL_CHAT_URL
  ?? buildChatUrl(process.env.SMALL_TALK_MODEL_BASE_URL ?? process.env.AGENT_LLM_BASE_URL ?? "http://127.0.0.1:8080/apis/ais-v2");
const SMALL_TALK_MODEL_NAME = process.env.SMALL_TALK_MODEL_NAME ?? process.env.AGENT_LLM_MODEL ?? "qwen3-1.7b-instruct";
const SMALL_TALK_MODEL_API_KEY = process.env.SMALL_TALK_MODEL_API_KEY ?? process.env.AGENT_LLM_API_KEY ?? "";
const SMALL_TALK_MODEL_TIMEOUT_MS = Number(process.env.SMALL_TALK_MODEL_TIMEOUT_MS ?? "12000");

const runtime = new OpenClawRuntime();

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "openclaw-runtime-execute",
      host: RUNTIME_HOST,
      port: RUNTIME_PORT,
    });
  }

  if (req.method === "POST" && req.url === "/execute") {
    try {
      const body = await readJsonBody(req) as ExecuteRequestBody;
      const input = typeof body.input === "string" ? body.input.trim() : "";
      const openId = typeof body.openId === "string" ? body.openId.trim() : "";

      if (!input) {
        return sendJson(res, 400, {
          ok: false,
          error: "input is required",
        });
      }

      const intentDecision = await decideIntentBySmallModel(input);
      if (intentDecision.intent === "casual_chat") {
        return sendJson(res, 200, {
          ok: true,
          taskId: `chat-${Date.now()}-${randomUUID().slice(0, 8)}`,
          result: intentDecision.casualReply,
          succeeded: [],
          failed: [],
        });
      }

      const taskId = `long-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] [${taskId}] 收到执行请求，openId=${openId || "unknown"}, input="${input.slice(0, 80)}..."`);

      const opcResult = await getRoutingFromOpcService(input);
      const selectedExperts = normalizeSelectedExperts(opcResult.selected_experts);
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] [${taskId}] OPC 路由完成，experts=${selectedExperts.map((e) => String(e.name ?? "")).join(",")}, tier=${opcResult.small_model?.tier ?? "?"}`);
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] [${taskId}] 开始调用 runtime.execute()...`);

      if (selectedExperts.length === 0) {
        return sendJson(res, 503, {
          ok: false,
          error: "opc_unavailable",
          message: "请先启动OPC服务后再试。",
        });
      }

      const collaborationEdges = normalizeEdges(opcResult.collaboration_plan?.edges);
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] [${taskId}] 协作依赖边（过滤后）: ${collaborationEdges.map((e) => `${e.from}->${e.to}`).join(", ") || "(无)"}`);
      const tier = normalizeTier(opcResult.small_model?.tier);
      const routingScore = normalizeScore(opcResult.small_model?.score);
      const routingBackend = typeof opcResult.small_model?.backend === "string" ? opcResult.small_model.backend : "unknown";
      const routingBackendReason = typeof opcResult.small_model?.backend_reason === "string" ? opcResult.small_model.backend_reason : "";

      const result = await runtime.execute({
        taskId,
        bossInstruction: input,
        small_model: {
          tier,
          score: routingScore,
          backend: routingBackend,
          backend_reason: routingBackendReason,
        },
        selected_experts: selectedExperts,
        collaboration_plan: { edges: collaborationEdges },
        info_pool_hits: opcResult.info_pool_hits ?? [],
        output_attribution: {
          ...(opcResult.output_attribution ?? {}),
          source: "competition-router+runtime-execute-server",
          routing_rating: {
            tier,
            score: routingScore,
            backend: routingBackend,
            backend_reason: routingBackendReason,
          },
        },
        runtime_trace: {
          ...(opcResult.runtime_trace ?? {}),
          source: "competition-router+runtime-execute-server",
          openId: openId || "unknown",
          routing_rating: {
            tier,
            score: routingScore,
            backend: routingBackend,
            backend_reason: routingBackendReason,
          },
        },
      });

      return sendJson(res, 200, {
        ok: true,
        taskId: result.taskId,
        result: buildReplyText(result),
        succeeded: result.succeeded,
        failed: result.failed,
      });
    } catch (error) {
      if (error instanceof OpcUnavailableError) {
        return sendJson(res, 503, {
          ok: false,
          error: "opc_unavailable",
          message: error.message,
        });
      }

      if (error instanceof SmallTalkModelError) {
        return sendJson(res, 502, {
          ok: false,
          error: "small_talk_model_error",
          message: error.message,
        });
      }

      return sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: "not_found",
    available: ["GET /health", "POST /execute"],
  });
});

server.listen(RUNTIME_PORT, RUNTIME_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] listening on http://${RUNTIME_HOST}:${RUNTIME_PORT}`);
  // eslint-disable-next-line no-console
  console.log("[runtime-execute] execute path: POST /execute");
});

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

async function decideIntentBySmallModel(input: string): Promise<IntentDecision> {
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
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "你是输入意图判别器。",
              "请把用户输入判定为 business_request 或 casual_chat。",
              "对于寒暄、拟声词、无意义文本、测试文本、情绪表达、闲聊、功能咨询，都判定为 casual_chat。",
              "只有明确包含创业执行目标、需要调研/策略/法务/市场/销售动作时，才判定为 business_request。",
              "你必须只输出 JSON 对象，格式如下：",
              '{"intent":"business_request|casual_chat","confidence":0-1,"reason":"<=30字","casual_reply":"当 intent=casual_chat 时给自然中文回复，否则留空"}',
              "不要输出 markdown，不要输出代码块。",
            ].join("\n"),
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

    const rawText = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
        .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text ?? "" : ""))
        .join("\n")
        .trim()
        : "";

    if (rawText.length === 0) {
      throw new SmallTalkModelError("意图小模型返回为空，无法完成判定。");
    }

    const jsonText = extractFirstJsonObject(rawText);
    if (!jsonText) {
      throw new SmallTalkModelError(`意图小模型返回非 JSON: ${rawText.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonText) as {
      intent?: unknown;
      confidence?: unknown;
      reason?: unknown;
      casual_reply?: unknown;
      casualReply?: unknown;
    };
    const intent = normalizeIntent(parsed.intent);
    const confidence = normalizeConfidence(parsed.confidence);
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const casualReplyRaw = typeof parsed.casual_reply === "string"
      ? parsed.casual_reply
      : typeof parsed.casualReply === "string"
        ? parsed.casualReply
        : "";
    const casualReply = casualReplyRaw.trim();

    if (intent === "casual_chat" && casualReply.length === 0) {
      throw new SmallTalkModelError("意图判定为 casual_chat，但未返回 casual_reply。");
    }

    return {
      intent,
      confidence,
      reason,
      casualReply,
    };
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

function normalizeIntent(intent: unknown): "business_request" | "casual_chat" {
  const value = String(intent ?? "").trim().toLowerCase();
  if (value === "business_request") {
    return "business_request";
  }
  if (value === "casual_chat") {
    return "casual_chat";
  }
  throw new SmallTalkModelError(`意图小模型返回非法 intent: ${String(intent)}`);
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return 0;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function buildChatUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

function normalizeSelectedExperts(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => typeof item.name === "string" && item.name.length > 0);
}

function normalizeEdges(input: unknown): CollaborationEdge[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const rawEdges = input
    .map((edge) => {
      const from = typeof (edge as { from?: unknown }).from === "string"
        ? String((edge as { from?: unknown }).from)
        : "";
      const to = typeof (edge as { to?: unknown }).to === "string"
        ? String((edge as { to?: unknown }).to)
        : "";

      return { from, to };
    })
    .filter((edge) => edge.from.length > 0 && edge.to.length > 0);

  // Convert to an acyclic subset so runtime dependency manager can always schedule.
  const dedup = new Set<string>();
  const dagEdges: CollaborationEdge[] = [];

  for (const edge of rawEdges) {
    const fromRank = AGENT_ORDER[edge.from] ?? Number.MAX_SAFE_INTEGER;
    const toRank = AGENT_ORDER[edge.to] ?? Number.MAX_SAFE_INTEGER;
    if (fromRank >= toRank) {
      continue;
    }

    const key = `${edge.from}->${edge.to}`;
    if (dedup.has(key)) {
      continue;
    }

    dedup.add(key);
    dagEdges.push(edge);
  }

  return dagEdges;
}

function normalizeTier(tier: unknown): "L1" | "L2" | "L3" {
  const value = String(tier ?? "L2").toUpperCase();
  if (value === "L1" || value === "L2" || value === "L3") {
    return value;
  }
  return "L2";
}

function normalizeScore(score: unknown): number {
  if (typeof score === "number" && Number.isFinite(score)) {
    return Math.max(0, Math.min(10, score));
  }
  if (typeof score === "string") {
    const parsed = Number(score);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(10, parsed));
    }
  }
  return 0;
}

async function getRoutingFromOpcService(input: string): Promise<OpcRouteResponse> {
  const timeoutMs = Number.isFinite(OPC_ROUTER_TIMEOUT_MS) && OPC_ROUTER_TIMEOUT_MS > 0
    ? OPC_ROUTER_TIMEOUT_MS
    : 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPC_ROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        input,
        try_remote_llm: OPC_ROUTER_TRY_REMOTE_LLM,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OpcUnavailableError("请先启动OPC服务后再试。");
    }

    const payload = await response.json() as OpcRouteResponse;
    if (!payload.ok) {
      throw new OpcUnavailableError(payload.message ?? "请先启动OPC服务后再试。");
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpcUnavailableError(`OPC服务响应超时（>${timeoutMs}ms），请稍后再试或调大 OPC_ROUTER_TIMEOUT_MS。`);
    }
    throw new OpcUnavailableError("请先启动OPC服务后再试。");
  } finally {
    clearTimeout(timer);
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
        resolve(JSON.parse(raw) as Record<string, unknown>);
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

function loadDotEnv(): void {
  // 优先从脚本文件向上查找 .env，确保 PM2 / frp 等 cwd 不同时也能正确加载
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    // modified-runtime/integrations/ -> ../../.. -> openclaw-runtime/
    path.resolve(__dirname, "..", "..", "..", ".env"),
    // 兜底：脚本文件同级的 .env
    path.resolve(__dirname, ".env"),
  ];

  let envPath: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      envPath = candidate;
      break;
    }
  }

  if (!envPath) {
    console.warn("[runtime-execute] .env 文件未找到，使用进程环境变量。已搜索路径:", candidates);
    return;
  }

  console.log(`[runtime-execute] 加载 .env: ${envPath}`);
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
