import type {
  BlackboardClient,
  DepartmentAgentRuntime,
  DepartmentName,
  DepartmentOutput,
  TaskInfo,
} from "../department-agents/base-agent";
import { LegalAgent } from "../department-agents/legal-agent";
import { MarketAgent } from "../department-agents/market-agent";
import { ResearchAgent } from "../department-agents/research-agent";
import { SalesAgent } from "../department-agents/sales-agent";
import { StrategyAgent } from "../department-agents/strategy-agent";
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
    this.seedTask(taskId, bossInstruction);

    const taskPlan = this.brainAdapter.fromRouterOutput(taskId, bossInstruction, brainOutput);
    const execution = await this.orchestrator.execute(taskPlan, {
      create: (department, planTaskId) => this.createAgent(department, planTaskId),
    });
    const trace = this.monitor.buildTaskTrace(taskId);

    return await this.aggregator.aggregate({
      taskPlan,
      brainOutput,
      execution: execution.report,
      outputs: execution.outputs,
      trace,
    });
  }

  private seedTask(taskId: string, bossInstruction: string): void {
    if (this.blackboard instanceof InMemoryBlackboard) {
      this.blackboard.seedTask({
        taskId,
        bossInstruction,
        complexity: "medium",
        priority: 1,
      });
    }
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
      case "research":
        return new ResearchAgent(taskId, this.blackboard);
      case "strategy":
        return new StrategyAgent(taskId, this.blackboard);
      case "legal":
        return new LegalAgent(taskId, this.blackboard);
      case "market":
        return new MarketAgent(taskId, this.blackboard);
      case "sales":
        return new SalesAgent(taskId, this.blackboard);
      default:
        throw new Error(`Unsupported department: ${department}`);
    }
  }
}

export const runtime = new OpenClawRuntime();

export default runtime;