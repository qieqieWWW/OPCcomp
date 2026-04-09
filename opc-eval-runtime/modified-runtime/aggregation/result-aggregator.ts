import type { DepartmentName, DepartmentOutput } from "../../department-agents/base-agent";
import type { DepartmentOutputs, FusionConfig, FusedResult } from "../blender";
import { LLMBlenderAdapter } from "../blender";
import type {
  AggregationMetadata,
  AggregatedRuntimeResult,
  BrainRouterOutput,
  DepartmentQualityScore,
  DepartmentResultCard,
  EnhancedExecutionTrace,
  ExecutionEvent,
  ExecutionResult,
  ExecutiveSummary,
  OutputAttribution,
  QualityAssessment,
  QualityGrade,
  TaskPlan,
} from "../orchestration/types";

export interface ResultAggregationInput {
  taskPlan: TaskPlan;
  brainOutput: BrainRouterOutput;
  execution: ExecutionResult;
  outputs: DepartmentOutput[];
  trace: ExecutionEvent[];
}

export interface ResultAggregatorConfig {
  fusionConfig?: FusionConfig;
  blenderApiKey?: string;
  blenderModel?: string;
  blenderBaseUrl?: string;
}

const QUALITY_RULE_VERSION = "quality-v3.0";
const AGGREGATION_VERSION = "2.0.0";
const SUMMARY_VERSION = "2.0.0";
const SCORING_VERSION = "2.0.0";
const RUNTIME_VERSION = "0.2.0";
const SCORING_METHOD = "weighted-average-v2";

const DEPARTMENT_ORDER: DepartmentName[] = ["evidence", "feasibility", "risk", "legal"];
const SCORING_WEIGHTS = {
  completeness: 0.35,
  depth: 0.25,
  consistency: 0.2,
  actionable: 0.2,
} as const;

const DEPARTMENT_WEIGHTS: Record<DepartmentName, number> = {
  evidence: 0.28,
  feasibility: 0.32,
  risk: 0.2,
  legal: 0.2,
};

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function gradeFromScore(score: number): QualityGrade {
  if (score >= 85) {
    return "A";
  }
  if (score >= 70) {
    return "B";
  }
  if (score >= 55) {
    return "C";
  }
  return "D";
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

export class ResultAggregator {
  private blenderAdapter: LLMBlenderAdapter;
  private fusionConfig: FusionConfig = {
    strategy: "consensus",
    temperature: 0.7,
    maxTokens: 1800,
    includeReasoning: false,
  };

  constructor(config: ResultAggregatorConfig = {}) {
    const apiKey = config.blenderApiKey
      ?? readEnv("BLENDER_API_KEY")
      ?? readEnv("AGENT_LLM_API_KEY");
    const model = config.blenderModel
      ?? readEnv("BLENDER_MODEL")
      ?? readEnv("AGENT_LLM_MODEL")
      ?? "gpt-4";
    const baseUrl = config.blenderBaseUrl
      ?? readEnv("BLENDER_BASE_URL")
      ?? readEnv("AGENT_LLM_BASE_URL");

    const adapterConfig: ConstructorParameters<typeof LLMBlenderAdapter>[0] = { model };
    if (apiKey) {
      adapterConfig.apiKey = apiKey;
    }
    if (baseUrl) {
      adapterConfig.baseUrl = baseUrl;
    }

    this.blenderAdapter = new LLMBlenderAdapter(adapterConfig);
    if (config.fusionConfig) {
      this.fusionConfig = { ...this.fusionConfig, ...config.fusionConfig };
    }
  }

  async aggregate(input: ResultAggregationInput): Promise<AggregatedRuntimeResult> {
    const started = Date.now();
    const cards = input.outputs.map((output) => this.buildCard(output));
    const byDepartment = this.indexOutputs(input.outputs);
    const quality = this.buildQualityAssessment(cards);
    const summary = this.buildExecutiveSummary(input.taskPlan, input.execution, byDepartment, cards, quality.overallScore);
    const trace = this.buildEnhancedTrace(input.trace);
    const attribution = this.buildAttribution(input, cards);
    const fusedResult = await this.performFusion(cards);
    const metadata = this.buildMetadata(input, quality, started);

    return {
      taskId: input.taskPlan.taskId,
      bossInstruction: input.taskPlan.bossInstruction,
      tier: input.taskPlan.tier,
      executiveSummary: summary,
      qualityScores: quality,
      qualityAssessment: quality,
      summary: summary.overview,
      departmentOutputs: cards,
      departments: cards,
      succeeded: input.execution.succeeded,
      failed: input.execution.failed,
      approvalRequired: input.execution.approvalRequired,
      approvalStatus: input.execution.approvalStatus,
      blockedByApproval: input.execution.blockedByApproval,
      executionOrder: input.execution.executionOrder,
      executionTrace: trace,
      trace: input.trace,
      outputAttribution: attribution,
      fusedResult,
      metadata,
      startedAt: input.execution.startedAt,
      finishedAt: input.execution.finishedAt,
      brainOutput: input.brainOutput,
    };
  }

  private buildCard(output: DepartmentOutput): DepartmentResultCard {
    const sourceKeys = Object.keys(output.output ?? {});
    const completeness = clampScore(sourceKeys.length * 20);
    const depth = clampScore(Math.min(100, safeStringify(output.output).length / 30));
    const consistency = output.status === "failed" ? 40 : 80;
    const operability = clampScore(this.extractActions(output.output).length * 20 + 40);
    const qualityScore = clampScore(
      completeness * SCORING_WEIGHTS.completeness
      + depth * SCORING_WEIGHTS.depth
      + consistency * SCORING_WEIGHTS.consistency
      + operability * SCORING_WEIGHTS.actionable,
    );

    return {
      department: output.department,
      status: output.status === "failed" ? "failed" : "completed",
      title: `${output.department} 部门结果`,
      summary: this.buildOutputSummary(output.output),
      sourceKeys,
      output: output.output,
      rawOutput: output.output,
      normalizedOutput: output.output,
      qualityScore,
      qualityGrade: gradeFromScore(qualityScore),
      qualityMetrics: {
        completeness,
        depth,
        consistency,
        operability,
      },
    };
  }

  private buildOutputSummary(output: Record<string, unknown>): string {
    const actions = this.extractActions(output);
    if (actions.length > 0) {
      return actions.slice(0, 2).join("；");
    }
    const keys = Object.keys(output);
    if (keys.length === 0) {
      return "无结构化输出";
    }
    return `包含字段：${keys.slice(0, 4).join("、")}`;
  }

  private extractActions(output: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    const keys = ["nextSteps", "recommendations", "actionPlan", "next_step", "roadmap_30d", "roadmap_60d", "roadmap_90d"];
    for (const key of keys) {
      const value = output[key];
      if (typeof value === "string" && value.trim()) {
        candidates.push(value.trim());
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            candidates.push(item.trim());
          }
        }
      }
    }
    return Array.from(new Set(candidates));
  }

  private indexOutputs(outputs: DepartmentOutput[]): Partial<Record<DepartmentName, DepartmentOutput>> {
    const map: Partial<Record<DepartmentName, DepartmentOutput>> = {};
    for (const output of outputs) {
      map[output.department] = output;
    }
    return map;
  }

  private buildQualityAssessment(cards: DepartmentResultCard[]): QualityAssessment {
    const departmentScores = {} as Record<DepartmentName, DepartmentQualityScore>;
    for (const department of DEPARTMENT_ORDER) {
      const card = cards.find((item) => item.department === department);
      const score = card?.qualityScore ?? 0;
      departmentScores[department] = {
        department,
        score,
        grade: gradeFromScore(score),
        metrics: card?.qualityMetrics ?? { completeness: 0, depth: 0, consistency: 0, operability: 0 },
        notes: card
          ? ["输出结构已生成。"]
          : ["该部门未参与或无输出。"],
      };
    }

    const overallScore = clampScore(
      DEPARTMENT_ORDER.reduce((sum, dep) => sum + departmentScores[dep].score * DEPARTMENT_WEIGHTS[dep], 0),
    );

    return {
      ruleVersion: QUALITY_RULE_VERSION,
      scoredAt: new Date().toISOString(),
      overallScore,
      overallGrade: gradeFromScore(overallScore),
      departmentScores,
      improvementSuggestions: DEPARTMENT_ORDER
        .filter((dep) => departmentScores[dep].score < 65)
        .map((dep) => `${dep} 输出深度偏低，建议补充量化依据与下一步动作。`),
      rawData: {
        weights: DEPARTMENT_WEIGHTS,
        departmentScores,
      },
    };
  }

  private buildExecutiveSummary(
    taskPlan: TaskPlan,
    execution: ExecutionResult,
    lookup: Partial<Record<DepartmentName, DepartmentOutput>>,
    cards: DepartmentResultCard[],
    qualityScore: number,
  ): ExecutiveSummary {
    const completedCount = cards.filter((item) => item.status === "completed").length;
    const failedCount = cards.filter((item) => item.status === "failed").length;
    const feasibilityScore = this.readFeasibilityScore(lookup.feasibility);
    const feasibilityVerdict: ExecutiveSummary["feasibilityVerdict"] = feasibilityScore >= 75
      ? "推进"
      : feasibilityScore >= 55
        ? "谨慎"
        : "暂停";
    const riskLevel = this.readRiskLevel(lookup.risk, lookup.legal);
    const businessValueRating: ExecutiveSummary["businessValueRating"] = feasibilityScore >= 75 ? "高" : feasibilityScore >= 55 ? "中" : "低";
    const overview = this.pickText(lookup.feasibility?.output, ["summary", "recommendation", "valueProposition"])
      ?? this.pickText(lookup.risk?.output, ["summary", "recommendation"])
      ?? this.pickText(lookup.evidence?.output, ["summary", "recommendation"])
      ?? "已完成多部门分析。";
    const nextStep = this.extractActions(lookup.legal?.output ?? {}).at(0)
      ?? this.extractActions(lookup.risk?.output ?? {}).at(0)
      ?? this.extractActions(lookup.feasibility?.output ?? {}).at(0)
      ?? "整理关键假设并启动为期 2 周的最小验证计划。";

    return {
      headline: execution.blockedByApproval ? `${taskPlan.taskId} 等待审批` : `${taskPlan.taskId} 执行完成`,
      overview,
      departmentCount: cards.length,
      completedCount,
      failedCount,
      qualityScore,
      feasibilityScore,
      feasibilityVerdict,
      businessValueRating,
      riskLevel,
      highlights: [
        `可行性评分 ${feasibilityScore}/100，建议 ${feasibilityVerdict}`,
        `质量评分 ${qualityScore}/100，评级 ${gradeFromScore(qualityScore)}`,
        `风险等级 ${riskLevel}`,
      ],
      businessValue: this.pickText(lookup.feasibility?.output, ["valueProposition", "summary", "recommendation"]) ?? "商业价值待进一步量化。",
      riskView: this.pickText(lookup.legal?.output, ["summary", "riskLevel", "compliance"]) ?? "风险已纳入后续评估。",
      priorityOrder: ["验证核心假设", "控制合规风险", "推进最小可行产品"],
      nextStep,
      warnings: failedCount > 0 ? [`${failedCount} 个部门执行失败，需复盘后重试。`] : [],
    };
  }

  private readFeasibilityScore(output?: DepartmentOutput): number {
    if (!output) {
      return 55;
    }
    const raw = output.output.feasibility_score ?? output.output.score ?? output.score;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return clampScore(raw);
    }
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampScore(parsed);
      }
    }
    return clampScore(output.score ?? 60);
  }

  private readRiskLevel(riskOutput?: DepartmentOutput, legalOutput?: DepartmentOutput): ExecutiveSummary["riskLevel"] {
    const text = `${safeStringify(riskOutput?.output ?? {})} ${safeStringify(legalOutput?.output ?? {})}`.toLowerCase();
    if (/高|high|critical|阻断/.test(text)) {
      return "高";
    }
    if (/中|medium|moderate|待复核/.test(text)) {
      return "中";
    }
    return "低";
  }

  private pickText(output: Record<string, unknown> | undefined, keys: string[]): string | null {
    if (!output) {
      return null;
    }
    for (const key of keys) {
      const value = output[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private buildEnhancedTrace(events: ExecutionEvent[]): EnhancedExecutionTrace {
    return {
      events,
      enhanced: true,
      steps: events.map((event) => ({
        name: event.type,
        timestamp: event.timestamp.toISOString(),
        duration: 0,
      })),
      errors: events
        .filter((event) => event.type === "department_failed")
        .map((event) => ({
          department: event.department ?? "legal",
          message: event.detail ?? "department_failed",
          timestamp: event.timestamp.toISOString(),
        })),
    };
  }

  private buildAttribution(input: ResultAggregationInput, cards: DepartmentResultCard[]): OutputAttribution {
    const departments: OutputAttribution["departments"] = {};
    for (const card of cards) {
      departments[card.department] = {
        status: card.status,
        sourceKeys: card.sourceKeys,
        score: card.qualityScore,
      };
    }

    return {
      taskId: input.taskPlan.taskId,
      brain: {
        selected_experts: input.brainOutput.selected_experts ?? [],
        small_model: input.brainOutput.small_model ?? {},
      },
      runtime: {
        tier: input.taskPlan.tier,
        execution_order: input.execution.executionOrder,
      },
      departments,
    };
  }

  private buildMetadata(input: ResultAggregationInput, quality: QualityAssessment, startedAtMs: number): AggregationMetadata {
    const now = new Date();
    const inputRaw = safeStringify(input.brainOutput);
    const departmentSnapshots: AggregationMetadata["departmentSnapshots"] = {};
    for (const output of input.outputs) {
      const raw = safeStringify(output.output);
      departmentSnapshots[output.department] = {
        hash: hashText(raw),
        timestamp: output.timestamp.toISOString(),
        size: raw.length,
      };
    }

    const nodeVersion = typeof process !== "undefined" ? process.version : undefined;

    return {
      aggregationVersion: AGGREGATION_VERSION,
      summaryGenerationVersion: SUMMARY_VERSION,
      scoringVersion: SCORING_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      aggregationTimestamp: now.toISOString(),
      inputReceivedTimestamp: input.brainOutput.input_received_timestamp ?? input.execution.startedAt.toISOString(),
      processingDurationMs: Math.max(0, Date.now() - startedAtMs),
      environment: (readEnv("NODE_ENV") === "production") ? "production" : "development",
      ...(nodeVersion ? { nodeVersion } : {}),
      inputHash: hashText(inputRaw),
      inputSize: inputRaw.length,
      scoringMethod: SCORING_METHOD,
      scoringWeights: {
        completeness: SCORING_WEIGHTS.completeness,
        depth: SCORING_WEIGHTS.depth,
        consistency: SCORING_WEIGHTS.consistency,
        actionable: SCORING_WEIGHTS.actionable,
      },
      dataSource: String(input.brainOutput.data_source ?? input.brainOutput.source ?? "runtime"),
      parentExecutionId: input.brainOutput.parent_execution_id ?? null,
      resultId: `${input.taskPlan.taskId}-${now.getTime()}`,
      resultVersion: Number(input.brainOutput.result_version ?? 1),
      previousResultId: input.brainOutput.previous_result_id ?? null,
      diffAvailable: false,
      exportFormat: input.brainOutput.export_format ?? "json",
      exportTimestamp: input.brainOutput.export_timestamp ?? null,
      departmentSnapshots,
      originalInput: {
        query: String(input.brainOutput.original_input?.query ?? input.taskPlan.bossInstruction),
        context: input.brainOutput.original_input?.context ?? {},
        options: input.brainOutput.original_input?.options ?? {},
      },
    };
  }

  private async performFusion(cards: DepartmentResultCard[]): Promise<FusedResult | null> {
    const inputs: DepartmentOutputs = {};
    for (const card of cards) {
      inputs[card.department] = this.buildFusionInputText(card);
    }

    const hasInputs = Object.values(inputs).some((item) => typeof item === "string" && item.trim().length > 0);
    if (!hasInputs) {
      return null;
    }

    try {
      return await this.blenderAdapter.fuse(inputs, this.fusionConfig);
    } catch (error) {
      const sourceDepartments = DEPARTMENT_ORDER.filter((dep) => typeof inputs[dep] === "string");
      return {
        type: "local-fallback-fusion",
        architecture: "local-priority-fallback",
        fusedContent: sourceDepartments.map((dep) => `${dep}: ${inputs[dep] ?? ""}`).join("\n\n"),
        fusionMethod: "rule-based-fusion",
        confidence: 0.55,
        sourceDepartments,
        rankingStrategy: "priority",
        fusionTimestamp: new Date().toISOString(),
        fusionMetadata: {
          reasoning: `blender_fallback: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private buildFusionInputText(card: DepartmentResultCard): string {
    const head = `[${card.department}] ${card.summary}`;
    const body = safeStringify(card.normalizedOutput);
    if (body.length <= 2400) {
      return `${head}\n${body}`;
    }
    return `${head}\n${body.slice(0, 2400)}...`;
  }
}
