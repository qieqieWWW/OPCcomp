import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";

interface MarketingPlan {
  campaignTheme: string;
  channels: string[];
  budgetSplit: Record<string, number>;
}

interface ContentStrategy {
  pillarTopics: string[];
  weeklyCadence: string;
}

interface BrandStrategy {
  brandPosition: string;
  voiceTone: string[];
  targetAudience: string[];
}

export class MarketAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("market", taskId, blackboard);
  }

  getDependencies(): ["strategy", "legal"] {
    return ["strategy", "legal"];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const strategyData = context.dependencies.strategy?.output ?? {};
    const legalData = context.dependencies.legal?.output ?? {};
    const plan = await this.marketingPlan(strategyData, legalData);
    const content = await this.contentCreation(plan);
    const brand = await this.brandPositioning(plan);

    return {
      department: "market",
      taskId: context.taskId,
      status: "completed",
      score: 85,
      output: {
        plan,
        content,
        brand,
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
      },
    };
  }

  private async marketingPlan(
    strategyData: Record<string, unknown>,
    legalData: Record<string, unknown>,
  ): Promise<MarketingPlan> {
    const strategyWeight = Object.keys(strategyData).length > 0 ? 0.7 : 0.5;
    const legalWeight = Object.keys(legalData).length > 0 ? 0.3 : 0.5;
    return {
      campaignTheme: "替老板干活的AI团队",
      channels: ["公众号", "短视频", "私域直播"],
      budgetSplit: {
        strategy: strategyWeight,
        legal: legalWeight,
      },
    };
  }

  private async contentCreation(plan: MarketingPlan): Promise<ContentStrategy> {
    return {
      pillarTopics: [
        `${plan.campaignTheme}案例`,
        "部门协同方法论",
        "AI团队降本增效",
      ],
      weeklyCadence: "每周3篇图文+2条短视频",
    };
  }

  private async brandPositioning(marketData: MarketingPlan): Promise<BrandStrategy> {
    return {
      brandPosition: "一人公司可落地的AI运营系统",
      voiceTone: ["专业", "务实", "可执行"],
      targetAudience: ["创业者", "小微企业负责人", ...marketData.channels],
    };
  }
}
