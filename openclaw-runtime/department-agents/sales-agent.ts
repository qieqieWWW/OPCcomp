import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";

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
    const strategy = await this.salesStrategy(marketPlan);
    const profiles = await this.customerProfiling(marketPlan);
    const conversion = await this.conversionPlan(strategy);

    return {
      department: "sales",
      taskId: context.taskId,
      status: "completed",
      score: 86,
      output: {
        strategy,
        profiles,
        conversion,
      },
      timestamp: new Date(),
      metadata: {
        dependencies: this.getDependencies(),
      },
    };
  }

  private async salesStrategy(marketPlan: Record<string, unknown>): Promise<SalesStrategy> {
    const hasMarket = Object.keys(marketPlan).length > 0;
    return {
      pitchAngles: hasMarket
        ? ["ROI可量化", "部署快", "降低人力成本"]
        : ["快速试点", "低风险接入"],
      pricingGuide: "基础版按席位，高级版按流程包年",
    };
  }

  private async customerProfiling(targetAudience: Record<string, unknown>): Promise<CustomerProfiles> {
    const prefix = Object.keys(targetAudience).length > 0 ? "来自市场画像" : "默认画像";
    return {
      primary: `${prefix}-10~50人团队创业公司`,
      secondary: ["传统企业数字化部门", "咨询与代运营团队"],
    };
  }

  private async conversionPlan(strategy: SalesStrategy): Promise<ConversionPlan> {
    return {
      stages: ["线索筛选", "需求访谈", "试点提案", `商务签约(${strategy.pricingGuide})`],
      followUpSla: "24小时内首次触达，72小时内二次跟进",
      closingSignals: ["明确预算", "明确决策人", "愿意试点"],
    };
  }
}
