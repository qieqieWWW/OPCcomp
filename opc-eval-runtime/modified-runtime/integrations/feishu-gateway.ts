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

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

const FEISHU_APP_ID = readEnv("FEISHU_APP_ID") ?? "";
const FEISHU_APP_SECRET = readEnv("FEISHU_APP_SECRET") ?? "";
const FEISHU_GATEWAY_HOST = readEnv("FEISHU_GATEWAY_HOST") ?? "0.0.0.0";
const FEISHU_GATEWAY_PORT = Number(readEnv("FEISHU_GATEWAY_PORT") ?? "9090");

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
  taskId: string;
  summary?: string;
  executiveSummary?: {
    overview?: string;
    highlights?: string[];
    businessValue?: string;
    riskView?: string;
    nextStep?: string;
  };
  departmentOutputs?: Array<{ summary?: string }>;
  fusedResult?: { fusedContent?: string } | null;
}): string {
  const summary = result.executiveSummary ?? {};
  const fused = normalizeText(result.fusedResult?.fusedContent);
  if (fused) {
    return fused;
  }

  const directSummary = normalizeText(result.summary) ?? normalizeText(summary.overview);
  if (directSummary) {
    return directSummary;
  }

  const freeTexts = [
    normalizeText(summary.businessValue),
    normalizeText(summary.riskView),
    normalizeText(summary.nextStep),
    ...(Array.isArray(summary.highlights) ? summary.highlights.map((item) => normalizeText(item)) : []),
    ...(Array.isArray(result.departmentOutputs)
      ? result.departmentOutputs.map((card) => normalizeText(card.summary))
      : []),
  ].filter((item): item is string => Boolean(item));

  if (freeTexts.length > 0) {
    return dedupeLines(freeTexts).join("\n\n");
  }

  return "已完成分析，但当前未返回可展示的文本结果。";
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : null;
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    output.push(line);
  }
  return output;
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
