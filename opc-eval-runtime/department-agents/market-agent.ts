import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureString, ensureStringArray, requestModelJson } from "./model-json";

interface RiskAssessment {
  riskLevel: "low" | "medium" | "high";
  riskSummary: string;
  blockers: string[];
  mitigation: string[];
  goNoGo: string;
}

export class RiskAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("risk", taskId, blackboard);
  }

  getDependencies(): ["evidence", "feasibility"] {
    return ["evidence", "feasibility"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const evidenceData = context.dependencies.evidence?.output ?? {};
    const feasibilityData = context.dependencies.feasibility?.output ?? {};
    const legalOutput = await this.blackboard.getDepartmentOutput(context.taskId, "legal");
    const legalData = legalOutput?.output ?? {};
    const generated = await this.generateRiskByModel(context.bossInstruction, evidenceData, feasibilityData, legalData);

    return {
      department: "risk",
      taskId: context.taskId,
      status: "completed",
      score: generated.riskLevel === "low" ? 88 : generated.riskLevel === "medium" ? 78 : 62,
      output: {
        riskLevel: generated.riskLevel,
        riskSummary: generated.riskSummary,
        blockers: generated.blockers,
        mitigation: generated.mitigation,
        goNoGo: generated.goNoGo,
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
        generationMode: "model-driven",
      },
    };
  }

  private async generateRiskByModel(
    bossInstruction: string,
    evidenceData: Record<string, unknown>,
    feasibilityData: Record<string, unknown>,
    legalData: Record<string, unknown>,
  ): Promise<RiskAssessment> {
    const systemPrompt = [
      "你是创业项目风险评估顾问。",
      "请基于任务、evidence、feasibility、legal 输出生成 risk 部门 JSON。",
      "只返回 JSON，不要解释。",
      "结构:",
      "{",
      "  \"riskLevel\": \"low\"|\"medium\"|\"high\",",
      "  \"riskSummary\": string,",
      "  \"blockers\": string[],",
      "  \"mitigation\": string[],",
      "  \"goNoGo\": string",
      "}",
      "要关注商业、资源、合规、时间和交付风险。",
    ].join("\n");

    const userPrompt = [
      `老板任务: ${bossInstruction}`,
      `evidence 输出(JSON): ${JSON.stringify(evidenceData).slice(0, 4500)}`,
      `feasibility 输出(JSON): ${JSON.stringify(feasibilityData).slice(0, 4500)}`,
      `legal 输出(JSON): ${JSON.stringify(legalData).slice(0, 4500)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    return {
      riskLevel: ensureString(raw.riskLevel, "medium") as "low" | "medium" | "high",
      riskSummary: ensureString(raw.riskSummary, "待模型补全"),
      blockers: ensureStringArray(raw.blockers, ["待模型补全"]),
      mitigation: ensureStringArray(raw.mitigation, ["待模型补全"]),
      goNoGo: ensureString(raw.goNoGo, "conditional-go"),
    };
  }
}