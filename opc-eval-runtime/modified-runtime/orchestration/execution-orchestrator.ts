import type { DepartmentAgentRuntime, DepartmentName, DepartmentOutput } from "../../department-agents/base-agent";
import { AgentExecutor } from "../execution/agent-executor";
import { ExecutionMonitor } from "../monitoring/execution-monitor";
import { DependencyManager } from "./dependency-manager";
import type { ExecutionResult, TaskPlan } from "./types";

interface ApprovalDecision {
  required: boolean;
  status: "not_required" | "approved" | "pending" | "rejected";
  blocked: boolean;
  detail?: string;
}

export interface AgentFactory {
  create(department: DepartmentName, taskId: string): DepartmentAgentRuntime;
}

export class ExecutionOrchestrator {
  constructor(
    private readonly executor = new AgentExecutor(),
    private readonly dependencyManager = new DependencyManager(),
    private readonly monitor = new ExecutionMonitor(),
  ) {}

  async execute(taskPlan: TaskPlan, factory: AgentFactory): Promise<{ outputs: DepartmentOutput[]; report: ExecutionResult }> {
    const startedAt = new Date();
    this.monitor.taskStarted(taskPlan.taskId);
    console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 开始执行任务`);

    const approvalDecision = this.evaluateApprovalGate(taskPlan);
    if (approvalDecision.required) {
      this.monitor.approvalRequired(taskPlan.taskId, approvalDecision.detail);
    }

    if (approvalDecision.status === "approved") {
      this.monitor.approvalGranted(taskPlan.taskId, approvalDecision.detail);
    }

    if (approvalDecision.blocked) {
      this.monitor.approvalBlocked(taskPlan.taskId, approvalDecision.detail ?? "任务被审批闸门拦截");
      this.monitor.taskFinished(taskPlan.taskId);
      return {
        outputs: [],
        report: {
          taskId: taskPlan.taskId,
          succeeded: [],
          failed: [],
          executionOrder: this.dependencyManager.getExecutionOrder(taskPlan),
          approvalRequired: approvalDecision.required,
          approvalStatus: approvalDecision.status,
          blockedByApproval: true,
          ...(approvalDecision.detail !== undefined ? { approvalDetail: approvalDecision.detail } : {}),
          startedAt,
          finishedAt: new Date(),
        },
      };
    }

    const succeeded: DepartmentName[] = [];
    const failed: DepartmentName[] = [];
    const outputs: DepartmentOutput[] = [];

    const executionOrder = this.dependencyManager.getExecutionOrder(taskPlan);
    console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 执行顺序: ${executionOrder.map(batch => `[${batch.join(',')}]`).join(' -> ')}`);

    for (const batch of executionOrder) {
      console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 开始批次: ${batch.join(',')}`);
      const agents = batch.map((department) => {
        this.monitor.departmentStarted(taskPlan.taskId, department);
        console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 创建 agent: ${department}`);
        return factory.create(department, taskPlan.taskId);
      });

      console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 开始执行批次 agents...`);
      const batchResults = await Promise.allSettled(agents.map((agent) => this.executor.execute(agent)));
      console.log(`[ExecutionOrchestrator] [${taskPlan.taskId}] 批次执行完成`);

      for (const [index, result] of batchResults.entries()) {
        const department = batch[index];
        if (!department || !result) {
          continue;
        }

        if (result.status === "fulfilled") {
          outputs.push(result.value);
          succeeded.push(department);
          this.monitor.departmentSucceeded(taskPlan.taskId, department);
          continue;
        }

        failed.push(department);
        this.monitor.departmentFailed(taskPlan.taskId, department, String(result.reason));
      }

      // 部分失败时继续执行后续批次，下游 agent 如果强依赖了失败部门，
      // 会在 preExecuteCheck 返回 false 时抛出 "Dependencies not ready"，由 catch 处理。
      // 仅当当前批次全部失败 且 历史上没有任何成功 时，提前中止以避免空跑。
      const batchAllFailed = batch.every((d) => failed.includes(d));
      if (batchAllFailed && succeeded.length === 0) {
        console.warn(
          `[ExecutionOrchestrator] 批次 [${batch.join(",")}] 全部失败且尚无任何成功部门，中止执行。`,
        );
        break;
      }
    }

    this.monitor.taskFinished(taskPlan.taskId);

    const report: ExecutionResult = {
      taskId: taskPlan.taskId,
      succeeded,
      failed,
      executionOrder,
      approvalRequired: approvalDecision.required,
      approvalStatus: approvalDecision.status,
      blockedByApproval: false,
      ...(approvalDecision.detail !== undefined ? { approvalDetail: approvalDecision.detail } : {}),
      startedAt,
      finishedAt: new Date(),
    };

    return { outputs, report };
  }

  private evaluateApprovalGate(taskPlan: TaskPlan): ApprovalDecision {
    void taskPlan;
    return { required: false, status: "not_required", blocked: false };
  }

  private readBoolean(container: Record<string, unknown>, key: string): boolean {
    return container[key] === true;
  }

  private readNestedBoolean(container: Record<string, unknown>, path: [string, string]): boolean {
    const parent = container[path[0]];
    if (!parent || typeof parent !== "object") {
      return false;
    }
    return (parent as Record<string, unknown>)[path[1]] === true;
  }

  private readApprovalStatus(raw: Record<string, unknown>): "approved" | "pending" | "rejected" | null {
    const direct = raw.approval_status;
    if (typeof direct === "string") {
      const normalized = direct.trim().toLowerCase();
      if (normalized === "approved" || normalized === "granted") {
        return "approved";
      }
      if (normalized === "pending" || normalized === "waiting") {
        return "pending";
      }
      if (normalized === "rejected" || normalized === "denied") {
        return "rejected";
      }
    }

    const nestedApproval = raw.approval;
    if (nestedApproval && typeof nestedApproval === "object") {
      const status = (nestedApproval as Record<string, unknown>).status;
      if (typeof status === "string") {
        const normalized = status.trim().toLowerCase();
        if (normalized === "approved" || normalized === "granted") {
          return "approved";
        }
        if (normalized === "pending" || normalized === "waiting") {
          return "pending";
        }
        if (normalized === "rejected" || normalized === "denied") {
          return "rejected";
        }
      }
    }

    return null;
  }

  private containsRiskyAction(instruction: string): boolean {
    return /(购买|下单|付款|支付|打款|转账|签约|合同|授权|开通|充值|采购|删除|发布生产|production|deploy|server|服务器|video\s*ai|视频\s*生成|browser\s*automation|网页\s*自动化|jimeng|jianying|即梦|api[\s-_]?key|密钥)/i.test(
      instruction,
    );
  }
}
