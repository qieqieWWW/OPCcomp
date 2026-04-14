import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureNumber, ensureString, ensureStringArray, requestModelJson } from "./model-json";

interface MarketAnalysis {
  marketSize: string;
  growthRate: string;
  keySegments: string[];
}

interface BusinessModel {
  valueProposition: string;
  revenueModel: string;
  costStructure: string[];
}

interface StrategyPlan {
  positioning: string;
  moat: string[];
  actionPlan: string[];
}

export class FeasibilityAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("feasibility", taskId, blackboard);
  }

  getDependencies(): ["evidence"] {
    return ["evidence"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const evidenceData = context.dependencies.evidence?.output ?? {};
    const routingSection = this.buildRoutingPromptSection(context);
    const generated = await this.generateStrategyByModel(context.bossInstruction, evidenceData, routingSection);

    return {
      department: "feasibility",
      taskId: context.taskId,
      status: "completed",
      score: 80,
      output: {
        feasibility_score: generated.feasibility_score,
        market_feasibility: generated.market_feasibility,
        resource_feasibility: generated.resource_feasibility,
        timeline_feasibility: generated.timeline_feasibility,
        recommendation: generated.recommendation,
        assumptions: generated.assumptions,
      },
      timestamp: new Date(),
      metadata: {
        basedOn: ["evidence"],
        generationMode: "model-driven",
      },
    };
  }

  private async generateStrategyByModel(
    bossInstruction: string,
    evidenceData: Record<string, unknown>,
    routingSection: string,
  ): Promise<{
    feasibility_score: number;
    market_feasibility: string;
    resource_feasibility: string;
    timeline_feasibility: string;
    recommendation: "go" | "conditional-go" | "no-go";
    assumptions: string[];
  }> {
    const systemPrompt = [
      "你是创业项目可行性评估顾问。",
      "请基于用户任务与 evidence 部门输出，生成 feasibility 部门 JSON。",
      "禁止返回解释性文字，只返回 JSON 对象。",
      "JSON 结构必须是:",
      "{",
      "  \"feasibility_score\": number,",
      "  \"market_feasibility\": string,",
      "  \"resource_feasibility\": string,",
      "  \"timeline_feasibility\": string,",
      "  \"recommendation\": \"go\"|\"conditional-go\"|\"no-go\",",
      "  \"assumptions\": string[]",
      "}",
      "要明确是否值得继续推进，以及理由是什么。",
      "强调成本、资源和时间约束，避免空泛叙述。",
    ].join("\n");

    const userPrompt = [
      routingSection ? `${routingSection}\n` : "",
      `老板任务: ${bossInstruction}`,
      `evidence 输出(JSON): ${JSON.stringify(evidenceData).slice(0, 6000)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt, { department: "feasibility" });
    const feasibilityScore = ensureNumber(raw.feasibility_score, 0);

    return {
      feasibility_score: feasibilityScore,
      market_feasibility: ensureString(raw.market_feasibility, "待模型补全"),
      resource_feasibility: ensureString(raw.resource_feasibility, "待模型补全"),
      timeline_feasibility: ensureString(raw.timeline_feasibility, "待模型补全"),
      recommendation: ensureString(raw.recommendation, feasibilityScore >= 60 ? "conditional-go" : "no-go") as "go" | "conditional-go" | "no-go",
      assumptions: ensureStringArray(raw.assumptions, ["待模型补全"]),
    };
  }
}
