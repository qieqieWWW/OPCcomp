import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";

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
    const market = await this.marketAnalysis(researchData);
    const businessModel = await this.designBusinessModel(market);
    const strategy = await this.competitorStrategy({ market, businessModel });

    return {
      department: "strategy",
      taskId: context.taskId,
      status: "completed",
      score: 80,
      output: {
        market,
        businessModel,
        strategy,
      },
      timestamp: new Date(),
      metadata: {
        basedOn: ["research"],
      },
    };
  }

  private async marketAnalysis(researchData: Record<string, unknown>): Promise<MarketAnalysis> {
    const hint = Object.keys(researchData).length > 0 ? "结合研发输出" : "基于老板输入";
    return {
      marketSize: "约120亿/年",
      growthRate: "18%",
      keySegments: [hint, "企业服务", "自动化运营"],
    };
  }

  private async designBusinessModel(marketData: MarketAnalysis): Promise<BusinessModel> {
    return {
      valueProposition: "用低成本AI团队替代高频重复岗位工作",
      revenueModel: "订阅制 + 增值服务",
      costStructure: ["模型推理", "数据采集", `市场投放(${marketData.growthRate})`],
    };
  }

  private async competitorStrategy(analysis: {
    market: MarketAnalysis;
    businessModel: BusinessModel;
  }): Promise<StrategyPlan> {
    return {
      positioning: "中小企业一站式AI运营中台",
      moat: ["部门协同流程资产", "行业模板沉淀"],
      actionPlan: [
        `优先攻击增长率${analysis.market.growthRate}的子市场`,
        `围绕${analysis.businessModel.revenueModel}优化定价`,
      ],
    };
  }
}
