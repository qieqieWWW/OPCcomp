import {
  AgentContext,
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentOutput,
} from "./base-agent";

interface PatentAnalysis {
  technicalSummary: string;
  keyTechnologies: string[];
  innovationPoints: string[];
  potentialRisks: string[];
}

interface FeasibilityResult {
  score: number;
  technicalFeasibility: number;
  resourceRequirements: string[];
  timelineEstimate: string;
}

interface ResearchReport {
  executiveSummary: string;
  detailedAnalysis: string;
  recommendations: string[];
  nextSteps: string[];
}

export class ResearchAgent extends DepartmentAgentRuntime {
  constructor(taskId: string, blackboard: BlackboardClient) {
    super("research", taskId, blackboard);
  }

  getDependencies(): [] {
    return [];
  }

  async execute(context: AgentContext): Promise<DepartmentOutput> {
    const patent = await this.parsePatent(context.bossInstruction);
    const feasibility = await this.assessFeasibility(patent);
    const report = await this.generateReport({ patent, feasibility, taskInfo: context.taskInfo });

    return {
      department: "research",
      taskId: context.taskId,
      status: "completed",
      score: feasibility.score,
      output: {
        patent,
        feasibility,
        report,
      },
      timestamp: new Date(),
      metadata: {
        dependencyCount: 0,
      },
    };
  }

  private async parsePatent(document: string): Promise<PatentAnalysis> {
    const seed = document.slice(0, 48);
    return {
      technicalSummary: `基于老板指令抽取的技术摘要: ${seed}`,
      keyTechnologies: ["核心算法", "数据管道", "部署体系"],
      innovationPoints: ["低成本自动化", "小模型路由", "多部门协同"],
      potentialRisks: ["数据质量波动", "算力瓶颈"],
    };
  }

  private async assessFeasibility(techInfo: PatentAnalysis): Promise<FeasibilityResult> {
    return {
      score: 82,
      technicalFeasibility: 84,
      resourceRequirements: ["2名工程师", "1名产品经理", "GPU推理环境"],
      timelineEstimate: `${techInfo.keyTechnologies.length + 3}周`,
    };
  }

  private async generateReport(data: {
    patent: PatentAnalysis;
    feasibility: FeasibilityResult;
    taskInfo: AgentContext["taskInfo"];
  }): Promise<ResearchReport> {
    return {
      executiveSummary: "技术方案具备落地条件，建议进入原型开发阶段。",
      detailedAnalysis: `复杂度=${data.taskInfo.complexity}，可行性评分=${data.feasibility.score}`,
      recommendations: ["优先实现核心能力", "并行建设评估指标"],
      nextSteps: ["输出PoC计划", "定义验收标准"],
    };
  }
}
