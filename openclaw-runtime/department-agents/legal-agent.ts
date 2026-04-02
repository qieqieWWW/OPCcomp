import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";

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
    const risks = await this.riskAssessment(techData);
    const compliance = await this.complianceCheck(techData);
    const ip = await this.ipProtectionStrategy(techData);

    return {
      department: "legal",
      taskId: context.taskId,
      status: "completed",
      score: 78,
      output: {
        risks,
        compliance,
        ip,
      },
      timestamp: new Date(),
      metadata: {
        reviewedDependencies: this.getDependencies(),
      },
    };
  }

  private async riskAssessment(techData: Record<string, unknown>): Promise<LegalRisks> {
    const hasData = Object.keys(techData).length > 0;
    return {
      high: hasData ? ["数据合规边界不清"] : ["需求信息不足"],
      medium: ["跨境数据传输条款待补齐"],
      low: ["商标注册流程可并行推进"],
    };
  }

  private async complianceCheck(_businessPlan: Record<string, unknown>): Promise<ComplianceIssues> {
    return {
      findings: ["需要补充用户授权记录", "日志留存周期需定义"],
      remediation: ["补充隐私协议", "建立审计日志策略"],
    };
  }

  private async ipProtectionStrategy(_patentInfo: Record<string, unknown>): Promise<IPStrategy> {
    return {
      filingPlan: ["核心算法发明专利", "产品品牌商标"],
      watchList: ["相似技术公开数据库", "竞品专利布局"],
    };
  }
}
