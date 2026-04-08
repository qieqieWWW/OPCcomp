import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureStringArray, requestModelJson } from "./model-json";

interface LegalRisks {
  high: string[];
  medium: string[];
  low: string[];
}

interface ComplianceIssues {
  findings: string[];
  remediation: string[];
}

interface IPStrategy {
  filingPlan: string[];
  watchList: string[];
}

export class LegalAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("legal", taskId, blackboard);
  }

  getDependencies(): ["research"] {
    return ["research"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const techData = context.dependencies.research?.output ?? {};
    const generated = await this.generateLegalByModel(context.bossInstruction, techData);

    return {
      department: "legal",
      taskId: context.taskId,
      status: "completed",
      score: 78,
      output: {
        risks: generated.risks,
        compliance: generated.compliance,
        ip: generated.ip,
      },
      timestamp: new Date(),
      metadata: {
        reviewedDependencies: this.getDependencies(),
        generationMode: "model-driven",
      },
    };
  }

  private async generateLegalByModel(
    bossInstruction: string,
    researchData: Record<string, unknown>,
  ): Promise<{ risks: LegalRisks; compliance: ComplianceIssues; ip: IPStrategy }> {
    const systemPrompt = [
      "你是法律合规顾问。",
      "请基于任务与 research 输出，给出 legal 部门 JSON。",
      "仅返回 JSON，不要附加说明。",
      "JSON 结构:",
      "{",
      "  \"risks\": { \"high\": string[], \"medium\": string[], \"low\": string[] },",
      "  \"compliance\": { \"findings\": string[], \"remediation\": string[] },",
      "  \"ip\": { \"filingPlan\": string[], \"watchList\": string[] }",
      "}",
    ].join("\n");

    const userPrompt = [
      `老板任务: ${bossInstruction}`,
      `research 输出(JSON): ${JSON.stringify(researchData).slice(0, 6000)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    const risksRaw = (raw.risks && typeof raw.risks === "object") ? raw.risks as Record<string, unknown> : {};
    const complianceRaw = (raw.compliance && typeof raw.compliance === "object") ? raw.compliance as Record<string, unknown> : {};
    const ipRaw = (raw.ip && typeof raw.ip === "object") ? raw.ip as Record<string, unknown> : {};

    return {
      risks: {
        high: ensureStringArray(risksRaw.high, ["待模型补全"]),
        medium: ensureStringArray(risksRaw.medium, ["待模型补全"]),
        low: ensureStringArray(risksRaw.low, ["待模型补全"]),
      },
      compliance: {
        findings: ensureStringArray(complianceRaw.findings, ["待模型补全"]),
        remediation: ensureStringArray(complianceRaw.remediation, ["待模型补全"]),
      },
      ip: {
        filingPlan: ensureStringArray(ipRaw.filingPlan, ["待模型补全"]),
        watchList: ensureStringArray(ipRaw.watchList, ["待模型补全"]),
      },
    };
  }
}
