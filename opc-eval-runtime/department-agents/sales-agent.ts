import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";
import { ensureString, ensureStringArray, requestModelJson } from "./model-json";

interface SalesStrategy {
  pitchAngles: string[];
  pricingGuide: string;
}

interface CustomerProfiles {
  primary: string;
  secondary: string[];
}

interface ConversionPlan {
  stages: string[];
  followUpSla: string;
  closingSignals: string[];
}

export class SalesAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("sales", taskId, blackboard);
  }

  getDependencies(): ["market"] {
    return ["market"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const marketPlan = context.dependencies.market?.output ?? {};
    const routingSection = this.buildRoutingPromptSection(context);
    const generated = await this.generateSalesByModel(context.bossInstruction, marketPlan, routingSection);

    return {
      department: "sales",
      taskId: context.taskId,
      status: "completed",
      score: 86,
      output: {
        strategy: generated.strategy,
        profiles: generated.profiles,
        conversion: generated.conversion,
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
        generationMode: "model-driven",
      },
    };
  }

  private async generateSalesByModel(
    bossInstruction: string,
    marketData: Record<string, unknown>,
    routingSection: string,
  ): Promise<{ strategy: SalesStrategy; profiles: CustomerProfiles; conversion: ConversionPlan }> {
    const systemPrompt = [
      "你是销售策略顾问。",
      "请基于老板任务与 market 输出生成 sales 部门 JSON。",
      "仅返回 JSON，不要输出解释文字。",
      "JSON 结构:",
      "{",
      "  \"strategy\": { \"pitchAngles\": string[], \"pricingGuide\": string },",
      "  \"profiles\": { \"primary\": string, \"secondary\": string[] },",
      "  \"conversion\": { \"stages\": string[], \"followUpSla\": string, \"closingSignals\": string[] }",
      "}",
    ].join("\n");

    const userPrompt = [
      routingSection ? `${routingSection}\n` : "",
      `老板任务: ${bossInstruction}`,
      `market 输出(JSON): ${JSON.stringify(marketData).slice(0, 6000)}`,
    ].join("\n\n");

    const raw = await requestModelJson<Record<string, unknown>>(systemPrompt, userPrompt, { department: "evidence" });
    const strategyRaw = (raw.strategy && typeof raw.strategy === "object") ? raw.strategy as Record<string, unknown> : {};
    const profilesRaw = (raw.profiles && typeof raw.profiles === "object") ? raw.profiles as Record<string, unknown> : {};
    const conversionRaw = (raw.conversion && typeof raw.conversion === "object") ? raw.conversion as Record<string, unknown> : {};

    return {
      strategy: {
        pitchAngles: ensureStringArray(strategyRaw.pitchAngles, ["待模型补全"]),
        pricingGuide: ensureString(strategyRaw.pricingGuide, "待模型补全"),
      },
      profiles: {
        primary: ensureString(profilesRaw.primary, "待模型补全"),
        secondary: ensureStringArray(profilesRaw.secondary, ["待模型补全"]),
      },
      conversion: {
        stages: ensureStringArray(conversionRaw.stages, ["待模型补全"]),
        followUpSla: ensureString(conversionRaw.followUpSla, "待模型补全"),
        closingSignals: ensureStringArray(conversionRaw.closingSignals, ["待模型补全"]),
      },
    };
  }
}
