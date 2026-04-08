export type DepartmentName = "research" | "strategy" | "legal" | "market" | "sales";

export interface TaskInfo {
  taskId: string;
  bossInstruction: string;
  complexity: "simple" | "medium" | "complex";
  priority: number;
  deadline?: Date;
  metadata?: Record<string, unknown>;
}

export interface DepartmentOutput {
  department: DepartmentName;
  taskId: string;
  output: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed";
  score?: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  taskId: string;
  bossInstruction: string;
  dependencies: Partial<Record<DepartmentName, DepartmentOutput>>;
  taskInfo: TaskInfo;
}

export interface BlackboardClient {
  getTask(taskId: string): Promise<TaskInfo | null>;
  getDepartmentOutput(taskId: string, department: DepartmentName): Promise<DepartmentOutput | null>;
  saveDepartmentOutput(output: DepartmentOutput): Promise<void>;
  updateTaskStatus(taskId: string, status: string): Promise<void>;
  checkDependencies(taskId: string, dependencies: DepartmentName[]): Promise<boolean>;
}

export abstract class DepartmentAgentRuntime {
  protected readonly department: DepartmentName;
  protected readonly taskId: string;
  protected readonly blackboard: BlackboardClient;

  constructor(department: DepartmentName, taskId: string, blackboard: BlackboardClient) {
    this.department = department;
    this.taskId = taskId;
    this.blackboard = blackboard;
  }

  getDepartment(): DepartmentName {
    return this.department;
  }

  abstract getDependencies(): DepartmentName[];

  async assembleContext(): Promise<AgentContext> {
    const taskInfo = await this.blackboard.getTask(this.taskId);
    if (!taskInfo) {
      throw new Error(`Task not found: ${this.taskId}`);
    }

    const dependencies = this.getDependencies();
    const outputs = await Promise.all(
      dependencies.map(async (department) => {
        const output = await this.blackboard.getDepartmentOutput(this.taskId, department);
        return [department, output] as const;
      }),
    );

    const dependencyMap: Partial<Record<DepartmentName, DepartmentOutput>> = {};
    for (const [department, output] of outputs) {
      if (output) {
        dependencyMap[department] = output;
      }
    }

    return {
      taskId: this.taskId,
      bossInstruction: taskInfo.bossInstruction,
      dependencies: dependencyMap,
      taskInfo,
    };
  }

  abstract execute(context: AgentContext): Promise<DepartmentOutput>;

  async preExecuteCheck(): Promise<boolean> {
    const dependencies = this.getDependencies();
    if (dependencies.length === 0) {
      return true;
    }
    return this.blackboard.checkDependencies(this.taskId, dependencies);
  }

  async postExecute(output: DepartmentOutput): Promise<void> {
    await this.blackboard.saveDepartmentOutput(output);
    await this.blackboard.updateTaskStatus(this.taskId, `${this.department}:completed`);
  }

  async run(): Promise<DepartmentOutput> {
    try {
      const ready = await this.preExecuteCheck();
      if (!ready) {
        throw new Error(`Dependencies not ready for ${this.department}`);
      }

      await this.blackboard.updateTaskStatus(this.taskId, `${this.department}:processing`);
      const context = await this.assembleContext();
      const output = await this.execute(context);
      await this.postExecute(output);
      return output;
    } catch (error) {
      this.handleError(error as Error);
      const failedOutput: DepartmentOutput = {
        department: this.department,
        taskId: this.taskId,
        output: { error: (error as Error).message },
        status: "failed",
        timestamp: new Date(),
      };
      await this.blackboard.saveDepartmentOutput(failedOutput);
      await this.blackboard.updateTaskStatus(this.taskId, `${this.department}:failed`);
      throw error;
    }
  }

  handleError(error: Error): void {
    console.error(`[${this.department}] task ${this.taskId} failed:`, error.message);
  }
}
