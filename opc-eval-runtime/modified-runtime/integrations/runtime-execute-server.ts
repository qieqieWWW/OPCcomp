/// <reference types="node" />

import * as http from "http";
import * as fs from "fs";
import { randomUUID } from "crypto";
import * as path from "path";
import { OpenClawRuntime } from "../runtime";

const WebSocket = require("ws") as typeof import("ws");
type RawData = import("ws").RawData;

type ExecuteRequestBody = {
  input?: unknown;
  openId?: unknown;
};

type RuntimeRelayExecuteRequest = {
  type: "execute_request";
  requestId: string;
  input: string;
  openId: string;
};

type RuntimeRelayExecuteResponse = {
  type: "execute_response";
  requestId: string;
  response: RuntimeExecuteResponse;
};

type RuntimeRelayRegisterMessage = {
  type: "register";
  role: "runtime-worker";
  clientId: string;
  version: string;
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
  conversation_reply?: string;
  remote_llm?: unknown;
  small_model?: {
    tier?: string;
  };
  selected_experts?: Array<Record<string, unknown>>;
  collaboration_plan?: {
    edges?: Array<{ from?: string; to?: string }>;
  };
  info_pool_hits?: Array<Record<string, unknown>>;
  knowledge_graph_hits?: Array<Record<string, unknown>>;
  output_attribution?: Record<string, unknown>;
  runtime_trace?: Record<string, unknown>;
  message?: string;
};

type RuntimeExecutionPayload = {
  ok: true;
  taskId: string;
  result: string;
  succeeded: unknown;
  failed: unknown;
  execution_trace: Record<string, unknown>;
};

type RuntimeExecuteResponse = RuntimeExecutionPayload | {
  ok: false;
  error: string;
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
const OPC_ROUTER_URL = process.env.OPC_ROUTER_URL ?? "http://127.0.0.1:18081/route";
// 默认 90s，包含本地小模型路由 + 可选 LLM 摘要，避免 60s 边界导致误判 unavailable
const OPC_ROUTER_TIMEOUT_MS = Number(process.env.OPC_ROUTER_TIMEOUT_MS ?? "90000");
// 默认关闭远程 LLM 摘要，避免 /route 额外 60s+ 开销导致端到端超时。
const OPC_ROUTER_TRY_REMOTE_LLM = String(process.env.OPC_ROUTER_TRY_REMOTE_LLM ?? "false").toLowerCase() === "true";
const RUNTIME_RELAY_URL = process.env.RUNTIME_RELAY_URL ?? "";
const RUNTIME_RELAY_TOKEN = process.env.RUNTIME_RELAY_TOKEN ?? "";
const RUNTIME_RELAY_CLIENT_ID = process.env.RUNTIME_RELAY_CLIENT_ID ?? `runtime-worker-${process.pid}`;

const runtime = new OpenClawRuntime();
let relaySocket: InstanceType<typeof WebSocket> | null = null;
let relayReconnectTimer: NodeJS.Timeout | null = null;

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

      const payload = await executeRuntimePipeline(input, openId);
      return sendJson(res, 200, payload);
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
  startRuntimeRelayClient();
});

async function executeRuntimePipeline(input: string, openId: string): Promise<RuntimeExecuteResponse> {
  const opcResult = await getRoutingFromOpcService(input);
  const intent = normalizeIntent(opcResult.intent);

  if (intent.type !== "task_request") {
    return {
      ok: true,
      taskId: `chat-${Date.now()}`,
      result: buildConversationReply(opcResult, input),
      succeeded: [],
      failed: [],
      execution_trace: {
        intent,
        source: "competition-router+runtime-execute-server",
      },
    };
  }

  const taskId = `long-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] 收到执行请求，openId=${openId || "unknown"}, input="${input.slice(0, 80)}..."`);

  const selectedExperts = normalizeSelectedExperts(opcResult.selected_experts);
  const expertsForExecution = selectedExperts.length > 0
    ? selectedExperts
    : buildDefaultExperts();
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] OPC 路由完成，experts=${expertsForExecution.map((e) => String(e.name ?? "")).join(",")}, tier=${opcResult.small_model?.tier ?? "?"}`);
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] 开始调用 runtime.execute()...`);

  if (selectedExperts.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[runtime-execute] [${taskId}] router returned empty selected_experts, fallback to default experts`);
  }

  const collaborationEdges = normalizeEdges(opcResult.collaboration_plan?.edges);
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] 协作依赖边（过滤后）: ${collaborationEdges.map((e) => `${e.from}->${e.to}`).join(", ") || "(无)"}`);
  const tier = normalizeTier(opcResult.small_model?.tier);

  // 合并 info_pool_hits 与 knowledge_graph_hits，统一作为证据命中传递
  const allHits = [
    ...(opcResult.info_pool_hits ?? []),
    ...(opcResult.knowledge_graph_hits ?? []),
  ];
  if (allHits.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[runtime-execute] [${taskId}] 聚合命中数据：${opcResult.info_pool_hits?.length ?? 0} info_pool + ${opcResult.knowledge_graph_hits?.length ?? 0} knowledge_graph = ${allHits.length} total`);
  }

  const result = await runtime.execute({
    taskId,
    bossInstruction: input,
    small_model: { tier },
    selected_experts: expertsForExecution,
    collaboration_plan: { edges: collaborationEdges },
    info_pool_hits: allHits,
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

  logRuntimeExecutionTrace(taskId, result);

  return {
    ok: true,
    taskId: result.taskId,
    result: buildReplyText(result),
    succeeded: result.succeeded,
    failed: result.failed,
    execution_trace: summarizeExecutionTrace(result),
  };
}

function startRuntimeRelayClient(): void {
  if (!RUNTIME_RELAY_URL) {
    // eslint-disable-next-line no-console
    console.log("[runtime-execute] RUNTIME_RELAY_URL 未配置，保持 HTTP 模式。");
    return;
  }

  const connect = (): void => {
    const relayUrl = buildRelayUrl(RUNTIME_RELAY_URL, RUNTIME_RELAY_TOKEN);
    // eslint-disable-next-line no-console
    console.log(`[runtime-execute] connecting relay: ${relayUrl.replace(/token=[^&]+/i, "token=***")}`);
    const socket = new WebSocket(relayUrl);
    relaySocket = socket;

    socket.on("open", () => {
      const registerMessage: RuntimeRelayRegisterMessage = {
        type: "register",
        role: "runtime-worker",
        clientId: RUNTIME_RELAY_CLIENT_ID,
        version: "1",
      };
      socket.send(JSON.stringify(registerMessage));
      // eslint-disable-next-line no-console
      console.log(`[runtime-execute] relay connected as ${RUNTIME_RELAY_CLIENT_ID}`);
    });

    socket.on("message", async (data: RawData) => {
      try {
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
        const message = JSON.parse(text) as Partial<RuntimeRelayExecuteRequest> & { type?: string; requestId?: string; input?: string; openId?: string };
        if (message.type !== "execute_request" || typeof message.requestId !== "string") {
          return;
        }
        const input = typeof message.input === "string" ? message.input : "";
        const openId = typeof message.openId === "string" ? message.openId : "";
        const response = await executeRuntimePipeline(input, openId);
        const relayResponse: RuntimeRelayExecuteResponse = {
          type: "execute_response",
          requestId: message.requestId,
          response,
        };
        socket.send(JSON.stringify(relayResponse));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[runtime-execute] relay message handling failed", error);
      }
    });

    socket.on("close", () => {
      relaySocket = null;
      // eslint-disable-next-line no-console
      console.warn("[runtime-execute] relay disconnected, scheduling reconnect...");
      if (relayReconnectTimer) {
        clearTimeout(relayReconnectTimer);
      }
      relayReconnectTimer = setTimeout(connect, 3000);
    });

    socket.on("error", (error: Error) => {
      // eslint-disable-next-line no-console
      console.error("[runtime-execute] relay websocket error", error);
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  };

  connect();
}

function buildRelayUrl(baseUrl: string, token: string): string {
  if (!token) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function buildReplyText(result: {
  taskId: string;
  summary?: string;
  evidenceBoundOutput?: {
    claims?: Array<{
      claim_id?: string;
      text?: string;
      evidence_ids?: string[];
      confidence?: number;
      decision_type?: string;
    }>;
    conflicts?: Array<{
      reason?: string;
      resolution?: string;
    }>;
    actions?: Array<{
      text?: string;
      owner?: string;
      due_hint?: string;
    }>;
    output_meta?: {
      coverage?: number;
      conflict_present?: boolean;
      degraded?: boolean;
      degrade_reason?: string;
    };
  };
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
  logEvidenceMetadata(result.taskId, result.evidenceBoundOutput);

  const evidenceBoundOutput = result.evidenceBoundOutput;
  const degradeReason = normalizeDegradeReason(evidenceBoundOutput?.output_meta?.degrade_reason);
  const hasConflict = Boolean(evidenceBoundOutput?.output_meta?.conflict_present)
    || (Array.isArray(evidenceBoundOutput?.conflicts) && evidenceBoundOutput.conflicts.length > 0);

  if (degradeReason) {
    // 协议红线：降级场景不输出确定性结论，改为待验证说明 + 补证动作。
    const degradedReply = renderDegradedEvidenceReply(evidenceBoundOutput, degradeReason);
    if (degradedReply) {
      // eslint-disable-next-line no-console
      console.warn(`[runtime-execute] [${result.taskId}] evidence-bound output degraded: ${degradeReason}`);
      return degradedReply;
    }
    return `FAULT_CODE:${degradeReason}`;
  }

  if (hasConflict) {
    const conflictReply = renderConflictGateReply(evidenceBoundOutput);
    if (conflictReply) {
      return conflictReply;
    }
    return "FAULT_CODE:EVIDENCE_CONFLICT";
  }

  const taskReport = renderTaskReport(result);
  if (taskReport) {
    return taskReport;
  }

  if (evidenceBoundOutput) {
    const rendered = renderEvidenceBoundOutput(evidenceBoundOutput);
    if (rendered) {
      return rendered;
    }
  }

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

function renderEvidenceBoundOutput(evidenceBoundOutput: {
  claims?: Array<{
    text?: string;
    confidence?: number;
    decision_type?: string;
  }>;
  conflicts?: Array<{
    reason?: string;
    resolution?: string;
  }>;
  actions?: Array<{
    text?: string;
    owner?: string;
    due_hint?: string;
  }>;
}): string {
  const claims = Array.isArray(evidenceBoundOutput.claims)
    ? dedupeSemanticLines(
        evidenceBoundOutput.claims
          .map((item) => normalizeText(item.text, 360))
          .filter((item): item is string => Boolean(item)),
      )
    : [];

  const actions = Array.isArray(evidenceBoundOutput.actions)
    ? dedupeSemanticLines(
        evidenceBoundOutput.actions
          .map((item) => {
            const text = normalizeText(item.text, 260);
            if (!text) {
              return null;
            }
            const owner = normalizeText(item.owner, 40);
            const dueHint = normalizeText(item.due_hint, 30);
            const suffix = [owner ? `负责人：${owner}` : "", dueHint ? `时限：${dueHint}` : ""].filter(Boolean).join("，");
            return suffix ? `${text}（${suffix}）` : text;
          })
          .filter((item): item is string => Boolean(item))
          .map(expandActionLine),
      )
    : [];

  const conflicts = Array.isArray(evidenceBoundOutput.conflicts)
    ? dedupeSemanticLines(
        evidenceBoundOutput.conflicts
          .map((item) => {
            const reason = normalizeText(item.reason, 320);
            const resolution = normalizeText(item.resolution, 260);
            if (!reason) {
              return null;
            }
            return resolution ? `待复核：${reason}；处理建议：${resolution}` : `待复核：${reason}`;
          })
          .filter((item): item is string => Boolean(item)),
      )
    : [];

  const parts: string[] = [];
  if (claims.length > 0) {
    parts.push(claims.join("\n"));
  }
  if (actions.length > 0) {
    parts.push(`下一步：${actions.join("；")}`);
  }
  if (conflicts.length > 0) {
    parts.push(conflicts.join("\n"));
  }

  return parts.join("\n\n").trim();
}

function renderTaskReport(result: {
  summary?: string;
  evidenceBoundOutput?: {
    claims?: Array<{
      claim_id?: string;
      text?: string;
      evidence_ids?: string[];
      confidence?: number;
      decision_type?: string;
    }>;
    conflicts?: Array<{
      reason?: string;
      resolution?: string;
    }>;
    actions?: Array<{
      text?: string;
      owner?: string;
      due_hint?: string;
    }>;
  };
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
  const evidenceBoundOutput = result.evidenceBoundOutput ?? {};
  const hasConflict = Array.isArray(evidenceBoundOutput.conflicts) && evidenceBoundOutput.conflicts.length > 0;

  const quickConclusionRaw = hasConflict
    ? null
    : normalizeText(summary.overview ?? result.summary ?? result.fusedResult?.fusedContent, 520);
  const quickConclusion = quickConclusionRaw ? cleanReportText(quickConclusionRaw) : null;
  const businessValue = cleanReportText(normalizeText(summary.businessValue, 420) ?? "");
  const nextStep = cleanReportText(normalizeText(summary.nextStep, 420) ?? "");
  const riskView = cleanReportText(normalizeText(summary.riskView, 420) ?? "");

  const highlights = Array.isArray(summary.highlights)
    ? dedupeSemanticLines(
        summary.highlights
          .map((item) => normalizeText(item, 420))
          .filter((item): item is string => Boolean(item))
          .map(cleanReportText),
      )
    : [];

  const claims = Array.isArray(evidenceBoundOutput.claims)
    ? dedupeSemanticLines(
        evidenceBoundOutput.claims
          .map((item) => normalizeText(item.text, 420))
          .filter((item): item is string => Boolean(item))
          .map(cleanReportText),
      )
    : [];

  const conflicts = Array.isArray(evidenceBoundOutput.conflicts)
    ? dedupeSemanticLines(
        evidenceBoundOutput.conflicts
          .map((item) => {
            const reason = normalizeText(item.reason, 320);
            const resolution = normalizeText(item.resolution, 260);
            if (!reason) {
              return null;
            }
            return resolution ? `${reason}；处理建议：${resolution}` : reason;
          })
          .filter((item): item is string => Boolean(item))
          .map(cleanReportText),
      )
    : [];

  const actions = Array.isArray(evidenceBoundOutput.actions)
    ? dedupeSemanticLines(
        evidenceBoundOutput.actions
          .map((item) => {
            const text = normalizeText(item.text, 320);
            if (!text) {
              return null;
            }
            const owner = normalizeText(item.owner, 40);
            const dueHint = normalizeText(item.due_hint, 30);
            const suffix = [owner ? `负责人：${owner}` : "", dueHint ? `时限：${dueHint}` : ""].filter(Boolean).join("，");
            return suffix ? `${text}（${suffix}）` : text;
          })
          .filter((item): item is string => Boolean(item))
          .map(expandActionLine)
          .map(cleanReportText),
      )
    : [];

  const departmentSummaries = Array.isArray(result.departmentOutputs)
    ? dedupeSemanticLines(
        result.departmentOutputs
          .map((item) => {
            const name = formatDepartmentName(item.department);
            const text = normalizeText(item.summary, 360);
            if (!name || !text) {
              return null;
            }
            return `${name}：${text}`;
          })
          .filter((item): item is string => Boolean(item))
          .map(cleanReportText),
      )
    : [];

  const allEvidenceText = [quickConclusion ?? "", businessValue, riskView, ...claims, ...highlights, ...departmentSummaries]
    .filter(Boolean)
    .join("\n");
  const consistencyNote = buildConsistencyNote(allEvidenceText);

  const sections: string[] = [];
  const intro = "以下按证据优先报告体整理，先给证据再给结论与动作。";

  const evidenceLines = claims.slice(0, 6);
  if (evidenceLines.length > 0) {
    sections.push(`一、证据锚点\n${evidenceLines.map((item) => `- ${item}`).join("\n")}`);
  }

  if (quickConclusion) {
    sections.push(`二、快速结论\n${quickConclusion}`);
  } else if (hasConflict) {
    sections.push("二、快速结论\n- 当前证据存在冲突，暂不输出单一确定性判断。请先按下方处理建议补充验证。");
  }

  const coreFindings = dedupeSemanticLines([
    ...(businessValue ? [`业务判断：${businessValue}`] : []),
    ...highlights.slice(0, 4),
    ...claims.slice(0, 4),
    ...(consistencyNote ? [consistencyNote] : []),
  ]);
  if (coreFindings.length > 0) {
    sections.push(`三、关键发现\n${coreFindings.map((item) => `- ${item}`).join("\n")}`);
  }

  if (departmentSummaries.length > 0) {
    sections.push(`四、分部门分析\n${departmentSummaries.map((item) => `- ${item}`).join("\n")}`);
  }

  const riskLines = dedupeSemanticLines([
    ...(riskView ? [riskView] : []),
    ...conflicts.slice(0, 4),
  ]);
  if (riskLines.length > 0) {
    sections.push(`五、风险与不确定性\n${riskLines.map((item) => `- ${item}`).join("\n")}`);
  }

  const nextActions = dedupeSemanticLines([
    ...(nextStep ? [expandActionLine(nextStep)] : []),
    ...actions.slice(0, 4),
  ]);
  if (nextActions.length > 0) {
    sections.push(`六、建议与下一步\n${nextActions.map((item) => `- ${item}`).join("\n")}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return [intro, ...sections].join("\n\n").trim();
}

function logEvidenceMetadata(taskId: string, evidenceBoundOutput?: {
  claims?: Array<{
    claim_id?: string;
    text?: string;
    evidence_ids?: string[];
    confidence?: number;
    decision_type?: string;
  }>;
  conflicts?: Array<{
    reason?: string;
    resolution?: string;
  }>;
}): void {
  if (!evidenceBoundOutput) {
    return;
  }

  const claims = Array.isArray(evidenceBoundOutput.claims)
    ? evidenceBoundOutput.claims.map((item) => ({
        claim_id: normalizeText(item.claim_id, 40) ?? "",
        decision_type: normalizeText(item.decision_type, 30) ?? "",
        confidence: typeof item.confidence === "number" ? Math.round(item.confidence * 100) : undefined,
        evidence_ids: Array.isArray(item.evidence_ids)
          ? item.evidence_ids.map((id) => normalizeText(id, 40)).filter((id): id is string => Boolean(id))
          : [],
      }))
    : [];

  const conflicts = Array.isArray(evidenceBoundOutput.conflicts)
    ? evidenceBoundOutput.conflicts.map((item) => ({
        reason: normalizeText(item.reason, 120) ?? "",
        resolution: normalizeText(item.resolution, 120) ?? "",
      }))
    : [];

  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] evidence metadata: ${JSON.stringify({ claims, conflicts }, null, 2)}`);
}

function cleanReportText(text: string): string {
  let out = text;
  out = out.replace(/推进推进/g, "推进");
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/[；;]+$/g, "");
  return out;
}

function tokenizeForSimilarity(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[，。；;：:！!？?、()（）\[\]{}“”"'`]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function lineSimilarity(a: string, b: string): number {
  const aa = new Set(tokenizeForSimilarity(a));
  const bb = new Set(tokenizeForSimilarity(b));
  if (aa.size === 0 || bb.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const token of aa) {
    if (bb.has(token)) {
      inter += 1;
    }
  }
  const union = aa.size + bb.size - inter;
  return union <= 0 ? 0 : inter / union;
}

function dedupeSemanticLines(lines: string[], threshold = 0.84): string[] {
  const output: string[] = [];
  for (const raw of lines) {
    const line = cleanReportText(raw);
    if (!line) {
      continue;
    }
    const duplicated = output.some((existing) => {
      if (existing === line) {
        return true;
      }
      if (existing.includes(line) || line.includes(existing)) {
        return true;
      }
      return lineSimilarity(existing, line) >= threshold;
    });
    if (!duplicated) {
      output.push(line);
    }
  }
  return output;
}

function extractScore(text: string, label: string): number | null {
  const pattern = new RegExp(`${label}[^\\d]{0,8}(\\d{1,3})\\s*/\\s*100`, "i");
  const matched = text.match(pattern);
  if (!matched) {
    return null;
  }
  const value = Number(matched[1]);
  return Number.isFinite(value) ? value : null;
}

function isHighRisk(text: string): boolean {
  return /风险等级\s*(高|high)|\bhigh\b.{0,8}风险|风险.{0,6}(高|high)/i.test(text);
}

function buildConsistencyNote(allText: string): string {
  const feasibility = extractScore(allText, "可行性评分");
  const quality = extractScore(allText, "质量评分");
  const highRisk = isHighRisk(allText);
  const weakMarket = /缺乏外部市场动态|竞品信息|市场验证不足|需求验证不足/i.test(allText);

  const notes: string[] = [];
  if (feasibility !== null && feasibility >= 80 && highRisk) {
    notes.push("一致性说明：技术实现可行，但市场/合规风险仍高，建议按 conditional-go 有条件推进。");
  }
  if (feasibility !== null && quality !== null && feasibility - quality >= 18) {
    notes.push("一致性说明：可行性评分高于质量评分，代表能做出来与当前材料质量存在差距，需先补齐计划与验证证据。");
  }
  if (weakMarket) {
    notes.push("一致性说明：市场验证证据不足已触发风险增益，建议在立项推进前完成竞品与需求证据补齐。");
  }

  return dedupeSemanticLines(notes).join(" ");
}

function expandActionLine(line: string): string {
  const text = cleanReportText(line);

  if (/市场调研|竞品|需求验证/i.test(text)) {
    return `${text}（执行细化：48小时内完成Top5竞品价格/卖点矩阵，72小时内补齐20份目标用户访谈摘要与渠道转化假设，输出一页定价与定位修订表）`;
  }

  if (/Arduino|许可证|开源许可|知识产权/i.test(text)) {
    return `${text}（执行细化：建立依赖清单SBOM，逐项核对GPL/MIT/Apache许可义务，完成数据库来源授权凭证归档与法务复核）`;
  }

  return text;
}

function formatDepartmentName(rawDepartment?: string): string | null {
  const department = normalizeText(rawDepartment, 40)?.toLowerCase();
  if (!department) {
    return null;
  }

  const mapping: Record<string, string> = {
    finance: "财务",
    financial: "财务",
    market: "市场",
    marketing: "市场",
    sales: "销售",
    growth: "增长",
    product: "产品",
    operations: "运营",
    operation: "运营",
    risk: "风险",
    legal: "法务",
    compliance: "合规",
    tech: "技术",
    technology: "技术",
    research: "研究",
    strategy: "战略",
    data: "数据",
    engineering: "工程",
    support: "支持",
    supply: "供应链",
    supply_chain: "供应链",
  };

  return mapping[department] ?? rawDepartment?.trim() ?? null;
}

function normalizeText(value: unknown, maxLen = 200): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLen - 1))}…`;
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

function normalizeDegradeReason(reason: unknown): "NO_EVIDENCE" | "STALE_EVIDENCE" | "EVIDENCE_CONFLICT" | "" {
  const value = String(reason ?? "").trim().toUpperCase();
  if (value === "NO_EVIDENCE" || value === "STALE_EVIDENCE" || value === "EVIDENCE_CONFLICT") {
    return value;
  }
  return "";
}

function renderConflictGateReply(evidenceBoundOutput: {
  conflicts?: Array<{ reason?: string; resolution?: string }>;
  actions?: Array<{ text?: string; owner?: string; due_hint?: string }>;
} | undefined): string {
  const conflicts = Array.isArray(evidenceBoundOutput?.conflicts)
    ? evidenceBoundOutput.conflicts
        .map((item) => {
          const reason = normalizeText(item.reason, 240);
          const resolution = normalizeText(item.resolution, 200);
          if (!reason) {
            return null;
          }
          return resolution ? `${reason}；建议：${resolution}` : reason;
        })
        .filter((item): item is string => Boolean(item))
    : [];

  const actions = Array.isArray(evidenceBoundOutput?.actions)
    ? evidenceBoundOutput.actions
        .map((item) => normalizeText(item.text, 180))
        .filter((item): item is string => Boolean(item))
    : [];

  const lines: string[] = [
    "当前证据存在冲突，暂不输出单一确定性结论。",
    ...(conflicts.length > 0 ? [`冲突说明：${conflicts.slice(0, 2).join("；")}`] : []),
    ...(actions.length > 0 ? [`建议补证动作：${actions.slice(0, 3).join("；")}`] : []),
    "FAULT_CODE:EVIDENCE_CONFLICT",
  ];

  return lines.join("\n");
}

function renderDegradedEvidenceReply(evidenceBoundOutput: {
  actions?: Array<{ text?: string; owner?: string; due_hint?: string }>;
  output_meta?: { coverage?: number };
} | undefined, degradeReason: "NO_EVIDENCE" | "STALE_EVIDENCE" | "EVIDENCE_CONFLICT"): string {
  if (degradeReason === "EVIDENCE_CONFLICT") {
    return renderConflictGateReply(evidenceBoundOutput as {
      conflicts?: Array<{ reason?: string; resolution?: string }>;
      actions?: Array<{ text?: string; owner?: string; due_hint?: string }>;
    });
  }

  const actions = Array.isArray(evidenceBoundOutput?.actions)
    ? evidenceBoundOutput.actions
        .map((item) => {
          const text = normalizeText(item.text, 180);
          if (!text) {
            return null;
          }
          const owner = normalizeText(item.owner, 30);
          return owner ? `${text}（负责人：${owner}）` : text;
        })
        .filter((item): item is string => Boolean(item))
    : [];

  const coverage = typeof evidenceBoundOutput?.output_meta?.coverage === "number"
    ? Math.round(evidenceBoundOutput.output_meta.coverage * 100)
    : null;

  const reasonText = degradeReason === "NO_EVIDENCE"
    ? "当前结论证据不足，暂不输出确定性判断。"
    : "当前证据已过期，需刷新后再输出确定性判断。";

  const lines: string[] = [
    reasonText,
    ...(coverage !== null ? [`证据覆盖率：${coverage}%`] : []),
    ...(actions.length > 0 ? [`建议补证动作：${actions.slice(0, 3).join("；")}`] : ["建议补证动作：补充最新数据、规则命中和仿真结果后重试。"]),
    `FAULT_CODE:${degradeReason}`,
  ];

  return lines.join("\n");
}

function buildConversationReply(opcResult: OpcRouteResponse, input: string): string {
  void input;
  const reply = sanitizeConversationReply(normalizeText(opcResult.conversation_reply, 500) ?? "");
  if (reply) {
    return reply;
  }

  // No template fallback: surface explicit fault when model chat reply is missing.
  return "FAULT_CODE:ERR_CHAT_MODEL_EMPTY";
}

function sanitizeConversationReply(raw: string): string {
  if (!raw) {
    return "";
  }

  let text = raw;
  text = text.replace(/<\|[^>]+\|>/g, " ");
  text = text.replace(/<\/?think>/gi, " ");
  text = text.replace(/<\|endoftext\|>/gi, " ");
  text = text.replace(/\s+/g, " ").trim();

  if (!text) {
    return "";
  }

  // Keep sanitizer format-only: no keyword-driven content branching.
  const explicitReply = text.match(/(?:^|\s)reply\s*=\s*(.+)$/i);
  const candidate = explicitReply?.[1] ? explicitReply[1] : text;

  const compact = candidate
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) {
    return "";
  }
  return compact.length > 2400 ? `${compact.slice(0, 2399)}…` : compact;
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

function buildDefaultExperts(): Array<Record<string, unknown>> {
  return [
    { name: "evidence_agent", role: "evidence", priority: 1 },
    { name: "feasibility_agent", role: "feasibility", priority: 2 },
    { name: "risk_agent", role: "risk", priority: 3 },
    { name: "legal_agent", role: "legal", priority: 4 },
  ];
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

function summarizeExecutionTrace(result: {
  executionOrder?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  executionTrace?: { steps?: Array<{ name?: string; duration?: number }>; errors?: Array<{ message?: string }>; events?: unknown[] };
  departmentOutputs?: Array<{ department?: string; status?: string; qualityScore?: number; summary?: string }>;
}): Record<string, unknown> {
  const steps = Array.isArray(result.executionTrace?.steps)
    ? result.executionTrace?.steps?.map((item) => ({
      name: item?.name ?? "",
      duration: item?.duration ?? 0,
    }))
    : [];

  const departments = Array.isArray(result.departmentOutputs)
    ? result.departmentOutputs.map((item) => ({
      department: item.department ?? "",
      status: item.status ?? "",
      qualityScore: item.qualityScore ?? 0,
      summary: normalizeText(item.summary, 120) ?? "",
    }))
    : [];

  return {
    executionOrder: result.executionOrder ?? [],
    succeeded: result.succeeded ?? [],
    failed: result.failed ?? [],
    eventCount: Array.isArray(result.executionTrace?.events) ? result.executionTrace?.events?.length ?? 0 : 0,
    errorCount: Array.isArray(result.executionTrace?.errors) ? result.executionTrace?.errors?.length ?? 0 : 0,
    steps,
    departments,
  };
}

function logRuntimeExecutionTrace(taskId: string, result: {
  executionOrder?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  executionTrace?: { steps?: Array<{ name?: string; duration?: number }>; errors?: Array<{ department?: string; message?: string }> };
  departmentOutputs?: Array<{ department?: string; status?: string; qualityScore?: number; summary?: string }>;
}): void {
  const summary = summarizeExecutionTrace(result);
  // eslint-disable-next-line no-console
  console.log(`[runtime-execute] [${taskId}] 执行阶段透明日志: ${JSON.stringify(summary)}`);

  const errors = Array.isArray(result.executionTrace?.errors) ? result.executionTrace?.errors : [];
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[runtime-execute] [${taskId}] executionTrace errors: ${JSON.stringify(errors)}`);
  }
}
