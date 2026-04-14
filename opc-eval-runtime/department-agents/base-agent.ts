import { AgentOfflineError } from "./model-json";

export type DepartmentName = "evidence" | "feasibility" | "risk" | "legal";

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

  /**
   * 从 taskInfo.metadata.routingContext 中提取精准路由上下文，生成可注入 prompt 的文本段落。
   * 返回空字符串表示没有路由上下文可用。
   *
   * 注入内容：
   *  1. 意图识别结果 + 置信度
   *  2. 研究侧风险评估
   *  3. 知识图谱命中内容（因果规律、节点关系）— 实际内容，非仅数量
   *  4. 信息池命中内容
   */
  protected buildRoutingPromptSection(context: AgentContext): string {
    const rc = context.taskInfo.metadata?.routingContext as Record<string, unknown> | undefined;
    if (!rc) return "";

    const parts: string[] = [];

    // 意图识别结果
    const intent = rc.intent as Record<string, unknown> | undefined;
    if (intent) {
      const intentType = String(intent.type ?? "task_request");
      const confidence = typeof intent.confidence === "number" ? Math.round(intent.confidence * 100) : null;
      const reason = String(intent.reason ?? "");
      const confStr = confidence !== null ? `，置信度 ${confidence}%` : "";
      const reasonStr = reason ? `（${reason}）` : "";
      parts.push(`意图识别：${intentType}${confStr}${reasonStr}`);
    }

    // research_fusion 风险等级
    const fusion = rc.researchFusion as Record<string, unknown> | undefined;
    if (fusion && typeof fusion === "object") {
      const riskLevel = String(fusion.research_risk_level ?? "");
      const enabled = fusion.enabled === true;
      if (enabled && riskLevel) {
        parts.push(`研究侧风险评估：${riskLevel}`);
      }
    }

    // 知识图谱命中内容（实际内容注入，而非仅数量）
    const kgHits = Array.isArray(rc.knowledgeGraphHits) ? rc.knowledgeGraphHits as Array<Record<string, unknown>> : [];
    const kgCount = typeof rc.knowledgeGraphHitCount === "number" ? rc.knowledgeGraphHitCount : kgHits.length;
    const infoHits = Array.isArray(rc.infoPoolHits) ? rc.infoPoolHits as Array<Record<string, unknown>> : [];
    const infoCount = typeof rc.infoPoolHitCount === "number" ? rc.infoPoolHitCount : infoHits.length;

    if (kgCount > 0 || infoCount > 0) {
      parts.push(`内部知识命中：知识图谱 ${kgCount} 条，信息池 ${infoCount} 条`);
    }

    // 将 KG 命中内容格式化注入（因果规律、节点关系）
    const kgDetails = this.formatKgHitsForPrompt(kgHits);
    if (kgDetails) {
      parts.push(kgDetails);
    }

    // 将信息池命中内容格式化注入
    const infoDetails = this.formatInfoPoolHitsForPrompt(infoHits);
    if (infoDetails) {
      parts.push(infoDetails);
    }

    return parts.length > 0 ? `【路由辅助信息】${parts.join("；")}` : "";
  }

  /**
   * 将知识图谱命中内容格式化为可注入 prompt 的文本。
   * 提取因果规律（edge 关系）、节点标签、置信度等关键信息。
   */
  private formatKgHitsForPrompt(hits: Array<Record<string, unknown>>): string {
    if (hits.length === 0) return "";

    const lines: string[] = [];
    const maxHits = Math.min(hits.length, 5); // 最多展示 5 条，避免 prompt 过长

    for (let i = 0; i < maxHits; i++) {
      const raw = hits[i];
      if (!raw) continue;
      const hit = raw as Record<string, any>;
      const lineParts: string[] = [];

      // 因果关系：source → target (relation)
      const source = String(hit.source_label ?? hit.source ?? hit.label ?? "");
      const target = String(hit.target_label ?? hit.target ?? "");
      const relation = String(hit.relation ?? hit.edge_type ?? hit.type ?? "");
      if (source && target && relation) {
        lineParts.push(`${source} → ${target}（${relation}）`);
      } else if (source) {
        lineParts.push(source);
      }

      // 置信度/得分
      const score = typeof hit.score === "number" ? hit.score : typeof hit.confidence === "number" ? hit.confidence : null;
      if (score !== null) {
        lineParts.push(`置信度 ${(score * 100).toFixed(0)}%`);
      }

      // 因果规律描述
      const description = String(hit.description ?? hit.snippet ?? hit.evidence_snippet ?? "");
      if (description && description.length > 5) {
        // 截断到 150 字符，避免 prompt 膨胀
        const truncated = description.length > 150 ? `${description.slice(0, 147)}…` : description;
        lineParts.push(truncated);
      }

      if (lineParts.length > 0) {
        lines.push(`[${i + 1}] ${lineParts.join("，")}`);
      }
    }

    if (lines.length === 0) return "";
    if (hits.length > maxHits) {
      lines.push(`…共 ${hits.length} 条（仅展示前 ${maxHits} 条）`);
    }
    return `【知识图谱参考】\n${lines.join("\n")}`;
  }

  /**
   * 将信息池命中内容格式化为可注入 prompt 的文本。
   */
  private formatInfoPoolHitsForPrompt(hits: Array<Record<string, unknown>>): string {
    if (hits.length === 0) return "";

    const lines: string[] = [];
    const maxHits = Math.min(hits.length, 3);

    for (let i = 0; i < maxHits; i++) {
      const raw = hits[i];
      if (!raw) continue;
      const hit = raw as Record<string, any>;
      const text = String(hit.text ?? hit.snippet ?? hit.title ?? hit.content ?? "");
      if (text.length > 3) {
        const truncated = text.length > 120 ? `${text.slice(0, 117)}…` : text;
        lines.push(`[${i + 1}] ${truncated}`);
      }
    }

    if (lines.length === 0) return "";
    if (hits.length > maxHits) {
      lines.push(`…共 ${hits.length} 条（仅展示前 ${maxHits} 条）`);
    }
    return `【信息池参考】\n${lines.join("\n")}`;
  }

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
      const isAgentOffline = error instanceof AgentOfflineError;
      const failedOutput: DepartmentOutput = {
        department: this.department,
        taskId: this.taskId,
        output: {
          error: (error as Error).message,
          degrade_reason: isAgentOffline ? "AGENT_OFFLINE" : undefined,
        },
        status: "failed",
        timestamp: new Date(),
        metadata: {
          ...(isAgentOffline ? {
            agentOffline: true,
            httpStatus: (error as AgentOfflineError).httpStatus,
            offlineDepartment: (error as AgentOfflineError).department,
          } : {}),
        },
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
