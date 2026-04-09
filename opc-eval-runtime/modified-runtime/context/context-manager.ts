import type {
  BlackboardClient,
  DepartmentName,
  DepartmentOutput,
  TaskInfo,
} from "../../department-agents/base-agent";

interface GenericDocument {
  [key: string]: unknown;
}

interface TaskDocument extends GenericDocument {
  taskId: string;
  bossInstruction: string;
  complexity: "simple" | "medium" | "complex";
  priority: number;
  deadline?: Date;
}

interface DepartmentOutputDocument extends GenericDocument {
  taskId: string;
  department: DepartmentName;
  output: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed";
  score?: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface CollectionLike<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>;
}

interface DbLike {
  collection<T>(name: string): CollectionLike<T>;
}

interface MongoClientLike {
  db(name: string): DbLike;
}

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export class ContextManager implements BlackboardClient {
  private readonly taskCollection: CollectionLike<TaskDocument>;
  private readonly outputCollection: CollectionLike<DepartmentOutputDocument>;

  constructor(
    private readonly mongodb: MongoClientLike,
    private readonly redis: RedisClientLike,
    dbName = "opc_system",
  ) {
    const db = this.mongodb.db(dbName);
    this.taskCollection = db.collection<TaskDocument>("tasks");
    this.outputCollection = db.collection<DepartmentOutputDocument>("department_outputs");
  }

  async getTask(taskId: string): Promise<TaskInfo | null> {
    const task = await this.taskCollection.findOne({ taskId });
    if (!task) {
      return null;
    }
    const taskInfo: TaskInfo = {
      taskId: task.taskId,
      bossInstruction: task.bossInstruction,
      complexity: task.complexity,
      priority: task.priority,
    };
    if (task.deadline !== undefined) {
      taskInfo.deadline = task.deadline;
    }
    return taskInfo;
  }

  async getDepartmentOutput(taskId: string, department: DepartmentName): Promise<DepartmentOutput | null> {
    const doc = await this.outputCollection.findOne({ taskId, department });
    if (!doc) {
      return null;
    }
    const output: DepartmentOutput = {
      department: doc.department,
      taskId: doc.taskId,
      output: doc.output,
      status: doc.status,
      timestamp: doc.timestamp,
    };
    if (doc.score !== undefined) {
      output.score = doc.score;
    }
    if (doc.metadata !== undefined) {
      output.metadata = doc.metadata;
    }
    return output;
  }

  async saveDepartmentOutput(output: DepartmentOutput): Promise<void> {
    await this.outputCollection.updateOne(
      { taskId: output.taskId, department: output.department },
      {
        $set: {
          taskId: output.taskId,
          department: output.department,
          output: output.output,
          status: output.status,
          score: output.score,
          timestamp: output.timestamp,
          metadata: output.metadata,
        },
      },
      { upsert: true },
    );

    const statusKey = `task:${output.taskId}:${output.department}:status`;
    await this.redis.set(statusKey, output.status);
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await this.redis.set(`task:${taskId}:status`, status);
  }

  async checkDependencies(taskId: string, dependencies: DepartmentName[]): Promise<boolean> {
    if (dependencies.length === 0) {
      return true;
    }

    const statusKeys = dependencies.map((department) => `task:${taskId}:${department}:status`);
    const statusValues: Array<string | null> = await Promise.all(
      statusKeys.map((key) => this.redis.get(key)),
    );
    return statusValues.every((status: string | null) => status === "completed");
  }
}
