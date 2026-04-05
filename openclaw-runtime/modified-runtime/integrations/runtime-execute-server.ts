/// <reference types="node" />

import * as http from "http";
import { randomUUID } from "crypto";
import { OpenClawRuntime } from "../runtime";

type ExecuteRequestBody = {
  input?: unknown;
  openId?: unknown;
};

const RUNTIME_HOST = process.env.RUNTIME_HOST ?? "0.0.0.0";
const RUNTIME_PORT = Number(process.env.RUNTIME_PORT ?? "30000");

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

      const taskId = `long-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const selectedExperts = selectExpertsByInstruction(input);
      const collaborationEdges = buildDefaultEdges(selectedExperts);

      const result = await runtime.execute({
        taskId,
        bossInstruction: input,
        small_model: { tier: "L2" },
        selected_experts: selectedExperts,
        collaboration_plan: { edges: collaborationEdges },
        info_pool_hits: [],
        output_attribution: { source: "runtime-execute-server" },
        runtime_trace: { source: "runtime-execute-server", openId: openId || "unknown" },
      });

      return sendJson(res, 200, {
        ok: true,
        taskId: result.taskId,
        result: buildReplyText(result),
        succeeded: result.succeeded,
        failed: result.failed,
      });
    } catch (error) {
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
  executiveSummary: { headline: string; overview: string; nextStep: string; warnings: string[] };
  succeeded: string[];
  failed: string[];
  qualityAssessment: { overallScore: number; overallGrade: string };
}): string {
  const warnings = result.executiveSummary.warnings.length > 0
    ? `风险提示: ${result.executiveSummary.warnings.join("；")}`
    : "风险提示: 无";

  return [
    `任务ID: ${result.taskId}`,
    `结论: ${result.executiveSummary.headline}`,
    `概览: ${result.executiveSummary.overview}`,
    `建议下一步: ${result.executiveSummary.nextStep}`,
    `成功部门: ${result.succeeded.join(",") || "无"}`,
    `失败部门: ${result.failed.join(",") || "无"}`,
    `质量评分: ${result.qualityAssessment.overallScore} (${result.qualityAssessment.overallGrade})`,
    warnings,
  ].join("\n");
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
