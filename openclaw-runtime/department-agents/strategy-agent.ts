import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureString, ensureStringArray, requestModelJson } from "./model-json";

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

export class StrategyAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("strategy", taskId, blackboard);
  }

  getDependencies(): ["research"] {
    return ["research"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const researchData = context.dependencies.research?.output ?? {};
    const generated = await this.generateStrategyByModel(context.bossInstruction, researchData);

    return {
      department: "strategy",
      taskId: context.taskId,
      status: "completed",
      score: 80,
      output: {
        market: generated.market,
        businessModel: generated.businessModel,
        strategy: generated.strategy,
      },
      timestamp: new Date(),
      metadata: {
        basedOn: ["research"],
        generationMode: "model-driven",
      },
    };
  }

  private async generateStrategyByModel(
    bossInstruction: string,
    researchData: Record<string, unknown>,
  ): Promise<{ market: MarketAnalysis; businessModel: BusinessModel; strategy: StrategyPlan }> {
    const systemPrompt = [
      "你是创业项目战略顾问。",
      "请基于用户任务与 research 部门输出，生成策略部门 JSON。",
      "禁止返回解释性文字，只返回 JSON 对象。",
      "JSON 结构必须是:",
      "{",
      "  \"market\": { \"marketSize\": string, \"growthRate\": string, \"keySegments\": string[] },",
      "  \"businessModel\": { \"valueProposition\": string, \"revenueModel\": string, \"costStructure\": string[] },",
      "  \"strategy\": { \"positioning\": string, \"moat\": string[], \"actionPlan\": string[] }",
      "}",
      "actionPlan 至少 3 条，且与当前任务场景强相关，不要套模板。",
      "强调成本与落地：优先 API/托管/轻量方案，避免无依据的大规模基础设施建议。",
      "除非用户明确要求架构设计，否则不要主动给出 GPU 集群、小模型路由、自建推理环境等建议。",
    ].join("\n");

    const userPrompt = [
      `老板任务: ${bossInstruction}`,
      `research 输出(JSON): ${JSON.stringify(researchData).slice(0, 6000)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt);
    const marketRaw = (raw.market && typeof raw.market === "object") ? raw.market as Record<string, unknown> : {};
    const modelRaw = (raw.businessModel && typeof raw.businessModel === "object") ? raw.businessModel as Record<string, unknown> : {};
    const strategyRaw = (raw.strategy && typeof raw.strategy === "object") ? raw.strategy as Record<string, unknown> : {};

    return {
      market: {
        marketSize: ensureString(marketRaw.marketSize, "待模型补全"),
        growthRate: ensureString(marketRaw.growthRate, "待模型补全"),
        keySegments: ensureStringArray(marketRaw.keySegments, ["待模型补全"]),
      },
      businessModel: {
        valueProposition: ensureString(modelRaw.valueProposition, "待模型补全"),
        revenueModel: ensureString(modelRaw.revenueModel, "待模型补全"),
        costStructure: ensureStringArray(modelRaw.costStructure, ["待模型补全"]),
      },
      strategy: {
        positioning: ensureString(strategyRaw.positioning, "待模型补全"),
        moat: ensureStringArray(strategyRaw.moat, ["待模型补全"]),
        actionPlan: ensureStringArray(strategyRaw.actionPlan, ["待模型补全"]),
      },
    };
  }
}
