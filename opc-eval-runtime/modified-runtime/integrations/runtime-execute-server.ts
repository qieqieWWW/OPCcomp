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

const AGENT_ORDER: Record<string, number> = {
  evidence_agent: 1,
  feasibility_agent: 2,
  risk_agent: 3,
  legal_agent: 4,
};

type OpcRouteResponse = {
  ok?: boolean;
  intent?: {
    type?: string;
    confidence?: number;
    reason?: string;
  };
  remote_llm?: unknown;
  small_model?: {
    tier?: string;
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

loadDotEnv();

const RUNTIME_HOST = process.env.RUNTIME_HOST ?? "0.0.0.0";
const RUNTIME_PORT = Number(process.env.RUNTIME_PORT ?? "30000");
const OPC_ROUTER_URL = process.env.OPC_ROUTER_URL ?? "http://127.0.0.1:18080/route";
// 默认 60s，包含本地小模型路由 + 可选 LLM 摘要，30s 在 LLM 慢响应时会超时
const OPC_ROUTER_TIMEOUT_MS = Number(process.env.OPC_ROUTER_TIMEOUT_MS ?? "60000");
const OPC_ROUTER_TRY_REMOTE_LLM = String(process.env.OPC_ROUTER_TRY_REMOTE_LLM ?? "true").toLowerCase() === "true";

const runtime = new OpenClawRuntime();

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "opc-eval-runtime-execute",
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

      const opcResult = await getRoutingFromOpcService(input);
      const intent = normalizeIntent(opcResult.intent);

      if (intent.type !== "task_request") {
        return sendJson(res, 200, {
          ok: true,
          taskId: `chat-${Date.now()}`,
          result: buildConversationReply(opcResult),
          succeeded: [],
          failed: [],
          intent,
        });
      }

      const taskId = `long-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] [${taskId}] 收到执行请求，openId=${openId || "unknown"}, input="${input.slice(0, 80)}..."`);

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

      const result = await runtime.execute({
        taskId,
        bossInstruction: input,
        small_model: { tier },
        selected_experts: selectedExperts,
        collaboration_plan: { edges: collaborationEdges },
        info_pool_hits: opcResult.info_pool_hits ?? [],
        output_attribution: {
          ...(opcResult.output_attribution ?? {}),
          source: "competition-router+runtime-execute-server",
        },
        runtime_trace: {
          ...(opcResult.runtime_trace ?? {}),
          source: "competition-router+runtime-execute-server",
          openId: openId || "unknown",
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
  taskId: string;
  summary?: string;
  executiveSummary?: {
    overview?: string;
    highlights?: string[];
    businessValue?: string;
    riskView?: string;
    nextStep?: string;
  };
  departmentOutputs?: Array<{ department?: string; summary?: string }>;
  fusedResult?: { fusedContent?: string } | null;
}): string {
  const summary = result.executiveSummary ?? {};
  const fused = normalizeText(result.fusedResult?.fusedContent);
  if (fused) {
    if (looksStructuredPayload(fused)) {
      // eslint-disable-next-line no-console
      console.warn(`[runtime-execute] [${result.taskId}] blocked structured fusedContent from user output`);
      return "FAULT_CODE:ERR_STRUCTURED_FUSION_BLOCKED";
    }
    return fused;
  }

  const directSummary = normalizeText(result.summary) ?? normalizeText(summary.overview);
  if (directSummary) {
    if (looksStructuredPayload(directSummary)) {
      // eslint-disable-next-line no-console
      console.warn(`[runtime-execute] [${result.taskId}] blocked structured directSummary from user output`);
      return "FAULT_CODE:ERR_STRUCTURED_SUMMARY_BLOCKED";
    }
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
    const merged = dedupeLines(freeTexts).join("\n\n");
    if (looksStructuredPayload(merged)) {
      // eslint-disable-next-line no-console
      console.warn(`[runtime-execute] [${result.taskId}] blocked structured merged text from user output`);
      return "FAULT_CODE:ERR_STRUCTURED_MERGE_BLOCKED";
    }
    return merged;
  }

  // eslint-disable-next-line no-console
  console.warn(`[runtime-execute] [${result.taskId}] no displayable user text from runtime result`);
  return "FAULT_CODE:ERR_NO_DISPLAYABLE_TEXT";
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

function looksStructuredPayload(text: string): boolean {
  const compact = text.trim();
  if (!compact) {
    return false;
  }

  if (/^[\[{]/.test(compact) && /[\]}]$/.test(compact)) {
    return true;
  }

  const jsonKeyLike = (compact.match(/"[\w.-]+"\s*:/g) ?? []).length;
  const braceCount = (compact.match(/[{}\[\]]/g) ?? []).length;
  const colonCount = (compact.match(/:/g) ?? []).length;

  if (jsonKeyLike >= 2) {
    return true;
  }

  if (braceCount >= 6 && colonCount >= 4) {
    return true;
  }

  return false;
}

function buildConversationReply(opcResult: OpcRouteResponse): string {
  const text = extractText(opcResult.remote_llm);
  if (text) {
    return text;
  }
  return "已识别为会话请求。";
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = normalizeText(value);
    return text;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [
      record.content,
      record.text,
      record.answer,
      record.result,
      record.output,
      record.message,
    ];
    for (const candidate of candidates) {
      const text = extractText(candidate);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function normalizeIntent(intent: OpcRouteResponse["intent"]): { type: "task_request" | "conversation_query"; confidence: number } {
  const rawType = String(intent?.type ?? "task_request").trim().toLowerCase();
  const type = rawType === "conversation_query" ? "conversation_query" : "task_request";
  const confidenceRaw = Number(intent?.confidence ?? 0.5);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0.01, Math.min(0.99, confidenceRaw))
    : 0.5;
  return { type, confidence };
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
    // modified-runtime/integrations/ -> ../../.. -> runtime root
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
