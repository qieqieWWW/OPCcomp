import type { DepartmentAgentRuntime, DepartmentOutput } from "../../department-agents/base-agent";

export interface ExecutionStatus {
  taskId: string;
  startedAt: Date;
  finishedAt?: Date;
  succeeded: string[];
  failed: string[];
  current?: string;
}

export class AgentExecutor {
  private readonly statusByTask = new Map<string, ExecutionStatus>();

  async executeParallel(agents: DepartmentAgentRuntime[]): Promise<DepartmentOutput[]> {
    return Promise.all(agents.map((agent) => this.execute(agent)));
  }

  async executeSequential(agents: DepartmentAgentRuntime[]): Promise<DepartmentOutput[]> {
    const outputs: DepartmentOutput[] = [];
    for (const agent of agents) {
      outputs.push(await this.execute(agent));
    }
    return outputs;
  }

  async execute(agent: DepartmentAgentRuntime): Promise<DepartmentOutput> {
    const taskId = (await agent.assembleContext()).taskId;
    if (!this.statusByTask.has(taskId)) {
      this.statusByTask.set(taskId, {
        taskId,
        startedAt: new Date(),
        succeeded: [],
        failed: [],
      });
    }

    const status = this.statusByTask.get(taskId);
    if (status) {
      status.current = agent.getDepartment();
    }

    try {
      const output = await agent.run();
      if (status) {
        status.succeeded.push(agent.getDepartment());
        status.current = undefined;
      }
      return output;
    } catch (error) {
      if (status) {
        status.failed.push(agent.getDepartment());
        status.current = undefined;
      }
      throw error;
    } finally {
      if (status && status.current === undefined) {
        const total = status.succeeded.length + status.failed.length;
        const activeTotal = Array.from(this.statusByTask.values())
          .filter((item) => item.taskId === taskId)
          .reduce((sum, item) => sum + item.succeeded.length + item.failed.length, 0);
        if (total > 0 && total === activeTotal) {
          status.finishedAt = new Date();
        }
      }
    }
  }

  async monitorExecution(taskId: string): Promise<ExecutionStatus> {
    const status = this.statusByTask.get(taskId);
    if (!status) {
      return {
        taskId,
        startedAt: new Date(),
        finishedAt: new Date(),
        succeeded: [],
        failed: [],
      };
    }
    return status;
  }
}
