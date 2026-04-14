import type {
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentName,
  DepartmentOutput,
  TaskInfo,
} from "../department-agents/base-agent";
import { EvidenceAgent } from "../department-agents/research-agent";
import { FeasibilityAgent } from "../department-agents/strategy-agent";
import { LegalAgent } from "../department-agents/legal-agent";
import { RiskAgent } from "../department-agents/market-agent";
import { AgentExecutor } from "./execution/agent-executor";
import { ResultAggregator } from "./aggregation";
import { ExecutionMonitor } from "./monitoring/execution-monitor";
import { BrainPlanAdapter } from "./orchestration/brain-plan-adapter";
import { DependencyManager } from "./orchestration/dependency-manager";
import { ExecutionOrchestrator } from "./orchestration/execution-orchestrator";
import type { AggregatedRuntimeResult, BrainRouterOutput } from "./orchestration/types";

interface RuntimeExecutionInput extends BrainRouterOutput {
  taskId?: string;
  task_id?: string;
  bossInstruction?: string;
  boss_instruction?: string;
  instruction?: string;
  /** 来自 Python pipeline 的知识图谱 / 信息池命中数据，用于生成真实证据 claims */
  info_pool_hits?: Array<Record<string, unknown>>;
  /** Python pipeline 的运行时追踪元数据 */
  runtime_trace?: Record<string, unknown>;
}

interface RuntimeOptions {
  blackboard?: BlackboardClient;
  brainAdapter?: BrainPlanAdapter;
  orchestrator?: ExecutionOrchestrator;
  aggregator?: ResultAggregator;
  monitor?: ExecutionMonitor;
}

class InMemoryBlackboard implements BlackboardClient {
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly outputs = new Map<string, Map<DepartmentName, DepartmentOutput>>();
  private readonly statuses = new Map<string, string>();

  seedTask(task: TaskInfo): void {
    this.tasks.set(task.taskId, task);
  }

  async getTask(taskId: string): Promise<TaskInfo | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async getDepartmentOutput(taskId: string, department: DepartmentName): Promise<DepartmentOutput | null> {
    return this.outputs.get(taskId)?.get(department) ?? null;
  }

  async saveDepartmentOutput(output: DepartmentOutput): Promise<void> {
    const taskOutputs = this.outputs.get(output.taskId) ?? new Map<DepartmentName, DepartmentOutput>();
    taskOutputs.set(output.department, output);
    this.outputs.set(output.taskId, taskOutputs);
    this.statuses.set(`task:${output.taskId}:${output.department}:status`, output.status);
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    this.statuses.set(taskId, status);
  }

  async checkDependencies(taskId: string, dependencies: DepartmentName[]): Promise<boolean> {
    return dependencies.every((department) => this.statuses.get(`task:${taskId}:${department}:status`) === "completed");
  }
}

export class OpenClawRuntime {
  private readonly blackboard: BlackboardClient;
  private readonly brainAdapter: BrainPlanAdapter;
  private readonly orchestrator: ExecutionOrchestrator;
  private readonly aggregator: ResultAggregator;
  private readonly monitor: ExecutionMonitor;

  constructor(options: RuntimeOptions = {}) {
    this.blackboard = options.blackboard ?? new InMemoryBlackboard();
    this.monitor = options.monitor ?? new ExecutionMonitor();
    this.brainAdapter = options.brainAdapter ?? new BrainPlanAdapter();
    this.aggregator = options.aggregator ?? new ResultAggregator();
    this.orchestrator = options.orchestrator ?? new ExecutionOrchestrator(new AgentExecutor(), new DependencyManager(), this.monitor);
  }

  async execute(brainOutput: RuntimeExecutionInput): Promise<AggregatedRuntimeResult> {
    const taskId = this.resolveTaskId(brainOutput);
    const bossInstruction = this.resolveBossInstruction(brainOutput);
    console.log(`[OpenClawRuntime] [${taskId}] 开始执行，指令: "${bossInstruction.slice(0, 50)}..."`);
    this.seedTask(taskId, bossInstruction, brainOutput);

    const taskPlan = this.brainAdapter.fromRouterOutput(taskId, bossInstruction, brainOutput);
    console.log(`[OpenClawRuntime] [${taskId}] taskPlan 创建完成，部门: ${taskPlan.departments?.join(',') || '无'}`);
    
    console.log(`[OpenClawRuntime] [${taskId}] 开始 orchestrator.execute()...`);
    const execution = await this.orchestrator.execute(taskPlan, {
      create: (department, planTaskId) => this.createAgent(department, planTaskId),
    });
    console.log(`[OpenClawRuntime] [${taskId}] orchestrator.execute() 完成，成功: ${execution.report.succeeded.length}, 失败: ${execution.report.failed.length}`);
    
    const trace = this.monitor.buildTaskTrace(taskId);
    console.log(`[OpenClawRuntime] [${taskId}] 开始 aggregator.aggregate()...`);

    // 将 Python 侧的真实证据数据（KG命中/信息池）透传给 ResultAggregator
    const externalEvidence = brainOutput.info_pool_hits ?? [];
    if (externalEvidence.length > 0) {
      console.log(`[OpenClawRuntime] [${taskId}] 透传 ${externalEvidence.length} 条真实证据给 ResultAggregator`);
    } else {
      console.log(`[OpenClawRuntime] [${taskId}] ⚠️ brainOutput.info_pool_hits 为空（Python pipeline 可能未返回 KG/信息池数据）`);
    }

    return await this.aggregator.aggregate({
      taskPlan,
      brainOutput,
      execution: execution.report,
      outputs: execution.outputs,
      trace,
      externalEvidence,
    });
  }

  private seedTask(taskId: string, bossInstruction: string, brainOutput: RuntimeExecutionInput): void {
    if (this.blackboard instanceof InMemoryBlackboard) {
      const tier = String(brainOutput.small_model?.tier ?? "L2").toUpperCase();
      const complexity = tier === "L1" ? "simple" : tier === "L3" ? "complex" : "medium";
      const priority = this.derivePriority(brainOutput, bossInstruction);
      const routingScore = this.normalizeScore(brainOutput.small_model?.score);

      this.blackboard.seedTask({
        taskId,
        bossInstruction,
        complexity,
        priority,
        metadata: {
          routingRating: {
            tier,
            score: routingScore,
            backend: brainOutput.small_model?.backend ?? "unknown",
            backendReason: brainOutput.small_model?.backend_reason ?? "",
          },
          // ── 精准路由上下文：注入到 taskInfo.metadata，供各 Agent prompt 消费 ──
          routingContext: {
            intent: brainOutput.intent ?? {},
            researchFusion: brainOutput.research_fusion ?? {},
            // 透传完整的 KG 命中内容（因果规律、节点信息），而非仅数量
            knowledgeGraphHits: brainOutput.knowledge_graph_hits ?? [],
            infoPoolHits: brainOutput.info_pool_hits ?? [],
            // 向后兼容：保留数量字段
            knowledgeGraphHitCount: brainOutput.knowledge_graph_hits?.length ?? 0,
            infoPoolHitCount: brainOutput.info_pool_hits?.length ?? 0,
          },
        },
      });
    }
  }

  private derivePriority(brainOutput: RuntimeExecutionInput, bossInstruction: string): number {
    const score = this.normalizeScore(brainOutput.small_model?.score);
    const text = bossInstruction.toLowerCase();
    const urgent = /(紧急|立刻|马上|今天|本周|deadline|urgent|asap)/.test(text);

    if (urgent || score >= 7) {
      return 3;
    }
    if (score >= 4) {
      return 2;
    }
    return 1;
  }

  private normalizeScore(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(10, value));
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(10, parsed));
      }
    }
    return 0;
  }

  private resolveTaskId(brainOutput: RuntimeExecutionInput): string {
    return String(brainOutput.taskId ?? brainOutput.task_id ?? `task-${Date.now()}`);
  }

  private resolveBossInstruction(brainOutput: RuntimeExecutionInput): string {
    const instruction = brainOutput.bossInstruction ?? brainOutput.boss_instruction ?? brainOutput.instruction;
    if (typeof instruction === "string" && instruction.trim().length > 0) {
      return instruction;
    }

    throw new Error("Brain output is missing boss instruction");
  }

  private createAgent(department: DepartmentName, taskId: string): DepartmentAgentRuntime {
    switch (department) {
      case "evidence":
        return new EvidenceAgent(taskId, this.blackboard);
      case "feasibility":
        return new FeasibilityAgent(taskId, this.blackboard);
      case "risk":
        return new RiskAgent(taskId, this.blackboard);
      case "legal":
        return new LegalAgent(taskId, this.blackboard);
      default:
        throw new Error(`Unsupported department: ${department}`);
    }
  }
}

export const runtime = new OpenClawRuntime();

export default runtime;