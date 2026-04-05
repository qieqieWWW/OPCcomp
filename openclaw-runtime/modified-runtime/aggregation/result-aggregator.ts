import type { DepartmentName, DepartmentOutput } from "../../department-agents/base-agent";
import type { DepartmentOutputs, FusionConfig, FusedResult } from "../blender";
import { LLMBlenderAdapter } from "../blender";
import type {
  AggregationMetadata,
  AggregatedRuntimeResult,
  BrainRouterOutput,
  DepartmentResultCard,
  DepartmentQualityScore,
  EnhancedExecutionTrace,
  ExecutionEvent,
  ExecutionResult,
  ExecutiveSummary,
  OutputAttribution,
  QualityAssessment,
  QualityGrade,
  TaskPlan,
} from "../orchestration/types";

const QUALITY_RULE_VERSION = "quality-v2.0";
const AGGREGATION_VERSION = "1.0.0";
const SUMMARY_VERSION = "1.0.0";
const SCORING_VERSION = "1.0.0";
const RUNTIME_VERSION = "0.1.0";
const SCORING_METHOD = "weighted-average-v1";
const SCORING_WEIGHTS = {
  completeness: 0.3,
  depth: 0.25,
  consistency: 0.25,
  actionable: 0.2,
} as const;

const DEPARTMENT_WEIGHTS: Record<DepartmentName, number> = {
  research: 0.22,
  strategy: 0.22,
  legal: 0.2,
  market: 0.18,
  sales: 0.18,
};

interface DepartmentScoreProfile {
  department: DepartmentName;
  expectedKeys: string[];
  depthPaths: string[][];
  actionPaths: string[][];
  improvementHint: string;
  consistencyChecks: Array<(output: Record<string, unknown>) => boolean>;
}

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

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export class ResultAggregator {
  private blenderAdapter: LLMBlenderAdapter | null = null;
  private fusionConfig: FusionConfig = {
    strategy: "consensus",
    temperature: 0.7,
    maxTokens: 2000,
    includeReasoning: false,
  };

  constructor(config: ResultAggregatorConfig = {}) {
    const apiKey = config.blenderApiKey ?? readEnv("BLENDER_API_KEY");
    const model = config.blenderModel ?? readEnv("BLENDER_MODEL") ?? "gpt-4";
    const baseUrl = config.blenderBaseUrl ?? readEnv("BLENDER_BASE_URL");
    const adapterConfig: ConstructorParameters<typeof LLMBlenderAdapter>[0] = {
      model,
    };

    if (baseUrl) {
      adapterConfig.baseUrl = baseUrl;
    }
    if (apiKey) {
      adapterConfig.apiKey = apiKey;
      console.log("[ResultAggregator] BlenderAdapter initialized with API key.");
    } else {
      console.log("[ResultAggregator] No BLENDER_API_KEY provided, using local fallback fusion.");
    }

    this.blenderAdapter = new LLMBlenderAdapter(adapterConfig);

    if (config.fusionConfig) {
      this.fusionConfig = {
        ...this.fusionConfig,
        ...config.fusionConfig,
      };
    }
  }

  async aggregate(input: ResultAggregationInput): Promise<AggregatedRuntimeResult> {
    const aggregationStartedAt = new Date();
    const departmentOutputs = input.outputs.map((output) => this.buildCard(output));
    const traceEvents = [...input.trace];
    const executionTrace = this.buildEnhancedExecutionTrace(traceEvents, input.execution);
    const departmentLookup = this.indexDepartmentOutputs(input.outputs);
    const qualityScores = this.buildDepartmentQualityScores(input.outputs);
    const qualityAssessment = this.buildQualityAssessment(qualityScores);
    const executiveSummary = this.buildExecutiveSummary(
      input.taskPlan,
      departmentLookup,
      departmentOutputs,
      input.execution,
      traceEvents,
    );
    const outputAttribution = this.buildOutputAttribution(input);
    const metadata = this.buildAggregationMetadata(input, qualityAssessment, aggregationStartedAt);
    const fusedResult = await this.performFusion(this.buildFusionInputs(departmentOutputs));

    return {
      taskId: input.taskPlan.taskId,
      bossInstruction: input.taskPlan.bossInstruction,
      tier: input.taskPlan.tier,
      executiveSummary,
      qualityScores: qualityAssessment,
      qualityAssessment,
      summary: executiveSummary.overview,
      departmentOutputs,
      departments: departmentOutputs,
      succeeded: input.execution.succeeded,
      failed: input.execution.failed,
      approvalRequired: input.execution.approvalRequired,
      approvalStatus: input.execution.approvalStatus,
      blockedByApproval: input.execution.blockedByApproval,
      executionOrder: input.execution.executionOrder,
      executionTrace,
      trace: traceEvents,
      outputAttribution,
      fusedResult,
      metadata,
      startedAt: input.execution.startedAt,
      finishedAt: input.execution.finishedAt,
      brainOutput: input.brainOutput,
    };
  }

  private buildCard(output: DepartmentOutput): DepartmentResultCard {
    const sourceKeys = Object.keys(output.output);
    const qualityScore = this.scoreFromDepartmentOutput(output);
    const normalizedOutput = this.normalizeOutput(output.output);

    return {
      department: output.department,
      status: output.status === "failed" ? "failed" : "completed",
      title: `${output.department} 部门结果`,
      summary: this.buildOutputSummary(output.output),
      sourceKeys,
      output: normalizedOutput,
      rawOutput: output.output,
      normalizedOutput,
      qualityScore: qualityScore.score,
      qualityGrade: qualityScore.grade,
      qualityMetrics: qualityScore.metrics,
    };
  }

  private buildExecutiveSummary(
    taskPlan: TaskPlan,
    departmentLookup: Record<string, DepartmentOutput>,
    departmentOutputs: DepartmentResultCard[],
    execution: ExecutionResult,
    trace: ExecutionEvent[],
  ): ExecutiveSummary {
    const completedCount = departmentOutputs.filter((item) => item.status === "completed").length;
    const failedCount = execution.failed.length;
    const qualityScore = this.calculateQualityScore(departmentOutputs, execution, trace);
    const feasibilityScore = this.deriveFeasibilityScore(departmentLookup.research, departmentLookup.legal);
    const feasibilityVerdict = this.deriveFeasibilityVerdict(feasibilityScore, departmentLookup.legal);
    const businessValueRating = this.deriveBusinessValueRating(departmentLookup.strategy, departmentLookup.market);
    const riskLevel = this.deriveRiskLevel(departmentLookup.legal, departmentLookup.market, departmentLookup.sales);
    const businessValue = this.buildBusinessValueSummary(departmentLookup.strategy, departmentLookup.market);
    const riskView = this.buildRiskSummary(departmentLookup.legal, departmentLookup.market, departmentLookup.sales);
    const priorityOrder = this.buildPriorityOrder(feasibilityScore, businessValueRating, riskLevel);
    let nextStep = this.buildNextStep(feasibilityVerdict, businessValueRating, riskLevel, priorityOrder);
    const blockedByApproval = execution.blockedByApproval;
    const highlights = [
      `综合可行性评分 ${feasibilityScore}/100，建议 ${feasibilityVerdict}`,
      `商业价值评级 ${businessValueRating}，核心价值主张已提炼`,
      `风险等级 ${riskLevel}，已生成应对建议`,
      `${trace.length} 条执行轨迹已记录`,
    ];
    const warnings = failedCount > 0 ? [`${failedCount} 个部门执行失败`] : [];

    if (blockedByApproval) {
      highlights.unshift(`审批闸门触发：${execution.approvalDetail ?? "任务需人工审批"}`);
      warnings.unshift("任务已被审批闸门拦截，等待人工审批后重试");
      nextStep = "请先完成人工审批，再重新触发运行时执行。";
    }

    const headline = blockedByApproval ? `${taskPlan.taskId} 等待审批` : `${taskPlan.taskId} 执行完成`;
    const overview = blockedByApproval
      ? `任务 ${taskPlan.taskId} 因审批未通过或未完成被拦截，尚未执行部门任务。`
      : `任务 ${taskPlan.taskId} 已执行 ${departmentOutputs.length} 个部门，成功 ${completedCount} 个，失败 ${failedCount} 个。`;

    return {
      headline,
      overview,
      departmentCount: departmentOutputs.length,
      completedCount,
      failedCount,
      qualityScore,
      feasibilityScore,
      feasibilityVerdict,
      businessValueRating,
      riskLevel,
      highlights,
      businessValue,
      riskView,
      priorityOrder,
      nextStep,
      warnings,
    };
  }

  private buildDepartmentQualityScores(outputs: DepartmentOutput[]): Record<DepartmentName, DepartmentQualityScore> {
    const lookup = this.indexDepartmentOutputs(outputs);
    return {
      research: this.scoreDepartment(lookup.research, this.getDepartmentProfile("research")),
      strategy: this.scoreDepartment(lookup.strategy, this.getDepartmentProfile("strategy")),
      legal: this.scoreDepartment(lookup.legal, this.getDepartmentProfile("legal")),
      market: this.scoreDepartment(lookup.market, this.getDepartmentProfile("market")),
      sales: this.scoreDepartment(lookup.sales, this.getDepartmentProfile("sales")),
    };
  }

  private buildQualityAssessment(
    departmentScores: Record<DepartmentName, DepartmentQualityScore>,
  ): QualityAssessment {
    const scoredAt = new Date().toISOString();
    const overallScore = this.calculateOverallQualityScore(departmentScores);
    const overallGrade = this.gradeFromScore(overallScore);
    const improvementSuggestions = this.buildImprovementSuggestions(departmentScores);

    return {
      ruleVersion: QUALITY_RULE_VERSION,
      scoredAt,
      overallScore,
      overallGrade,
      departmentScores,
      improvementSuggestions,
      rawData: {
        weights: DEPARTMENT_WEIGHTS,
        departmentScores,
      },
    };
  }

  private calculateOverallQualityScore(
    departmentScores: Record<DepartmentName, DepartmentQualityScore>,
  ): number {
    const weighted = Object.entries(DEPARTMENT_WEIGHTS).reduce((sum, [department, weight]) => {
      return sum + (departmentScores[department as DepartmentName]?.score ?? 0) * weight;
    }, 0);
    return this.clampScore(Math.round(weighted));
  }

  private buildImprovementSuggestions(
    departmentScores: Record<DepartmentName, DepartmentQualityScore>,
  ): string[] {
    const weakDepartments = Object.values(departmentScores)
      .sort((left, right) => left.score - right.score)
      .slice(0, 2);

    return weakDepartments.map((item) => {
      const prefix = item.score >= 90 ? "相对可继续打磨" : "需要加强";
      return `${item.department} ${prefix}：${item.notes[0] ?? "补充更完整、可执行的输出。"}`;
    });
  }

  private scoreFromDepartmentOutput(output: DepartmentOutput): DepartmentQualityScore {
    const profile = this.getDepartmentProfile(output.department);
    return this.scoreDepartment(output, profile);
  }

  private scoreDepartment(
    output: DepartmentOutput | undefined,
    profile: DepartmentScoreProfile,
  ): DepartmentQualityScore {
    if (!output) {
      return {
        department: profile.department,
        score: 0,
        grade: "D",
        metrics: {
          completeness: 0,
          depth: 0,
          consistency: 0,
          operability: 0,
        },
        notes: ["部门输出缺失，无法进行质量评分。"],
      };
    }

    const completeness = this.calculateCompleteness(output.output, profile.expectedKeys);
    const depth = this.calculateDepth(output.output, profile.depthPaths);
    const consistency = this.calculateConsistency(output.output, profile.expectedKeys, profile.consistencyChecks);
    const operability = this.calculateOperability(output.output, profile.actionPaths);
    const score = this.clampScore(
      Math.round(
        (completeness * SCORING_WEIGHTS.completeness)
          + (depth * SCORING_WEIGHTS.depth)
          + (consistency * SCORING_WEIGHTS.consistency)
          + (operability * SCORING_WEIGHTS.actionable),
      ),
    );
    const grade = this.gradeFromScore(score);
    const notes = this.buildDepartmentNotes(profile.department, completeness, depth, consistency, operability, profile.improvementHint);

    return {
      department: profile.department,
      score,
      grade,
      metrics: {
        completeness,
        depth,
        consistency,
        operability,
      },
      notes,
    };
  }

  private getDepartmentProfile(department: DepartmentName): DepartmentScoreProfile {
    switch (department) {
      case "research":
        return {
          department,
          expectedKeys: ["patent", "feasibility", "report"],
          depthPaths: [
            ["patent", "technicalSummary"],
            ["patent", "keyTechnologies"],
            ["patent", "innovationPoints"],
            ["feasibility", "score"],
            ["feasibility", "resourceRequirements"],
            ["report", "executiveSummary"],
            ["report", "recommendations"],
            ["report", "nextSteps"],
          ],
          actionPaths: [["report", "recommendations"], ["report", "nextSteps"], ["feasibility", "resourceRequirements"]],
          improvementHint: "补充专利分析细节、可行性论证和更明确的落地路径。",
          consistencyChecks: [
            (output) => this.hasValue(output, ["feasibility", "score"]),
            (output) => this.hasValue(output, ["report", "executiveSummary"]),
          ],
        };
      case "strategy":
        return {
          department,
          expectedKeys: ["market", "businessModel", "strategy"],
          depthPaths: [
            ["market", "marketSize"],
            ["market", "growthRate"],
            ["market", "keySegments"],
            ["businessModel", "valueProposition"],
            ["businessModel", "revenueModel"],
            ["businessModel", "costStructure"],
            ["strategy", "positioning"],
            ["strategy", "moat"],
            ["strategy", "actionPlan"],
          ],
          actionPaths: [["strategy", "actionPlan"], ["businessModel", "revenueModel"], ["strategy", "moat"]],
          improvementHint: "补强商业模式链路、定价逻辑与可执行策略。",
          consistencyChecks: [
            (output) => this.hasValue(output, ["businessModel", "valueProposition"]),
            (output) => this.hasValue(output, ["strategy", "positioning"]),
          ],
        };
      case "legal":
        return {
          department,
          expectedKeys: ["risks", "compliance", "ip"],
          depthPaths: [
            ["risks", "high"],
            ["risks", "medium"],
            ["risks", "low"],
            ["compliance", "findings"],
            ["compliance", "remediation"],
            ["ip", "filingPlan"],
            ["ip", "watchList"],
          ],
          actionPaths: [["compliance", "remediation"], ["ip", "filingPlan"], ["ip", "watchList"]],
          improvementHint: "补齐风险分层、合规整改建议和 IP 保护动作。",
          consistencyChecks: [
            (output) => this.hasValue(output, ["risks", "high"]),
            (output) => this.hasValue(output, ["compliance", "findings"]),
          ],
        };
      case "market":
        return {
          department,
          expectedKeys: ["plan", "content", "brand"],
          depthPaths: [
            ["plan", "campaignTheme"],
            ["plan", "channels"],
            ["plan", "budgetSplit"],
            ["content", "pillarTopics"],
            ["content", "weeklyCadence"],
            ["brand", "brandPosition"],
            ["brand", "targetAudience"],
            ["brand", "voiceTone"],
          ],
          actionPaths: [["content", "pillarTopics"], ["brand", "targetAudience"], ["plan", "channels"]],
          improvementHint: "补强市场定位、竞争差异化与增长路径表达。",
          consistencyChecks: [
            (output) => this.hasValue(output, ["plan", "campaignTheme"]),
            (output) => this.hasValue(output, ["brand", "brandPosition"]),
          ],
        };
      case "sales":
        return {
          department,
          expectedKeys: ["strategy", "profiles", "conversion"],
          depthPaths: [
            ["strategy", "pitchAngles"],
            ["strategy", "pricingGuide"],
            ["profiles", "primary"],
            ["profiles", "secondary"],
            ["conversion", "stages"],
            ["conversion", "followUpSla"],
            ["conversion", "closingSignals"],
          ],
          actionPaths: [["conversion", "stages"], ["conversion", "followUpSla"], ["strategy", "pitchAngles"]],
          improvementHint: "补齐转化漏斗、跟进节奏和成交动作链路。",
          consistencyChecks: [
            (output) => this.hasValue(output, ["strategy", "pricingGuide"]),
            (output) => this.hasValue(output, ["profiles", "primary"]),
          ],
        };
    }
  }

  private calculateCompleteness(output: Record<string, unknown>, expectedKeys: string[]): number {
    if (expectedKeys.length === 0) {
      return 0;
    }
    const hitCount = expectedKeys.filter((key) => this.hasValue(output, [key])).length;
    return this.clampScore((hitCount / expectedKeys.length) * 100);
  }

  private calculateDepth(output: Record<string, unknown>, depthPaths: string[][]): number {
    const signals = depthPaths.flatMap((path) => this.extractDepthSignals(output, path));
    const stringVolume = signals.filter((value) => typeof value === "string").reduce((sum, value) => sum + value.length, 0);
    const arrayCount = signals.filter(Array.isArray).reduce((sum, value) => sum + (value as unknown[]).length, 0);
    const objectCount = signals.filter((value) => value && typeof value === "object" && !Array.isArray(value)).length;
    const score = 20 + (arrayCount * 4) + (objectCount * 7) + Math.floor(stringVolume / 18);
    return this.clampScore(score);
  }

  private calculateConsistency(
    output: Record<string, unknown>,
    expectedKeys: string[],
    checks: Array<(output: Record<string, unknown>) => boolean>,
  ): number {
    let score = 100;
    for (const key of expectedKeys) {
      if (!this.hasValue(output, [key])) {
        score -= 18;
      }
    }
    for (const check of checks) {
      if (!check(output)) {
        score -= 12;
      }
    }
    return this.clampScore(score);
  }

  private calculateOperability(output: Record<string, unknown>, actionPaths: string[][]): number {
    if (actionPaths.length === 0) {
      return 0;
    }
    const actionSignals = actionPaths.filter((path) => this.hasValue(output, path)).length;
    const score = (actionSignals / actionPaths.length) * 100;
    return this.clampScore(Math.round(score));
  }

  private extractDepthSignals(value: Record<string, unknown>, path: string[]): Array<string | unknown[] | Record<string, unknown>> {
    const resolved = this.getValueByPath(value, path);
    if (resolved == null) {
      return [];
    }
    if (Array.isArray(resolved) || typeof resolved === "string") {
      return [resolved];
    }
    if (typeof resolved === "object") {
      return [resolved as Record<string, unknown>];
    }
    return [];
  }

  private buildDepartmentNotes(
    department: DepartmentName,
    completeness: number,
    depth: number,
    consistency: number,
    operability: number,
    hint: string,
  ): string[] {
    const notes: string[] = [];
    if (completeness < 80) {
      notes.push(`${department} 完整性不足，需补齐关键字段。`);
    }
    if (depth < 80) {
      notes.push(`${department} 深度偏浅，建议增加分析层次和案例。`);
    }
    if (consistency < 80) {
      notes.push(`${department} 内部一致性偏弱，需统一论证与结论。`);
    }
    if (operability < 80) {
      notes.push(`${department} 可操作性不足，建议增加更明确的动作建议。`);
    }
    notes.push(hint);
    return notes;
  }

  private gradeFromScore(score: number): QualityGrade {
    if (score >= 90) {
      return "A";
    }
    if (score >= 80) {
      return "B";
    }
    if (score >= 70) {
      return "C";
    }
    return "D";
  }

  private hasValue(output: Record<string, unknown>, path: string[]): boolean {
    const resolved = this.getValueByPath(output, path);
    if (resolved == null) {
      return false;
    }
    if (typeof resolved === "string") {
      return resolved.trim().length > 0;
    }
    if (Array.isArray(resolved)) {
      return resolved.length > 0;
    }
    if (typeof resolved === "object") {
      return Object.keys(resolved as Record<string, unknown>).length > 0;
    }
    return true;
  }

  private getValueByPath(value: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private indexDepartmentOutputs(outputs: DepartmentOutput[]): Record<string, DepartmentOutput> {
    return outputs.reduce<Record<string, DepartmentOutput>>((accumulator, output) => {
      accumulator[output.department] = output;
      return accumulator;
    }, {});
  }

  private async performFusion(departments: DepartmentOutputs): Promise<FusedResult | null> {
    const validDepartments = Object.entries(departments)
      .filter(([, output]) => typeof output === "string" && output.trim().length > 50);

    if (validDepartments.length === 0) {
      console.warn("[ResultAggregator] No valid department outputs for fusion.");
      return null;
    }

    console.log(`[ResultAggregator] Starting fusion with ${validDepartments.length} departments.`);
    console.log(`[ResultAggregator] Sources: ${validDepartments.map(([department]) => department).join(", ")}`);

    if (!this.blenderAdapter) {
      console.warn("[ResultAggregator] BlenderAdapter not initialized, fusion skipped.");
      return null;
    }

    try {
      const startedAt = Date.now();
      const fusedResult = await this.blenderAdapter.fuse(departments, this.fusionConfig);
      const latencyMs = Date.now() - startedAt;

      console.log("[ResultAggregator] Fusion completed successfully.");
      console.log(`[ResultAggregator] Method: ${fusedResult.fusionMethod}`);
      console.log(`[ResultAggregator] Confidence: ${(fusedResult.confidence * 100).toFixed(1)}%`);
      console.log(`[ResultAggregator] Latency: ${latencyMs}ms`);

      return fusedResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ResultAggregator] Fusion failed: ${message}`);

      if (/api|key|auth|authentication/i.test(message)) {
        console.warn("[ResultAggregator] Falling back to local fusion.");
        return this.performLocalFallbackFusion(departments, message);
      }

      return this.performLocalFallbackFusion(departments, message);
    }
  }

  private performLocalFallbackFusion(departments: DepartmentOutputs, reason: string): FusedResult | null {
    const priorityOrder: Array<keyof DepartmentOutputs> = ["research", "strategy", "legal", "market", "sales"];
    const validOutputs = priorityOrder
      .map((department) => ({ department, content: departments[department] }))
      .filter((item): item is { department: keyof DepartmentOutputs; content: string } => (
        typeof item.content === "string" && item.content.trim().length > 0
      ));

    if (validOutputs.length === 0) {
      return null;
    }

    const fusedContent = validOutputs
      .map(({ department, content }) => `## ${department.toUpperCase()}\n\n${content.trim()}\n`)
      .join("\n---\n\n");

    const confidence = Math.min(0.5 + (validOutputs.length * 0.1), 0.9);

    return {
      type: "local-fallback-fusion",
      architecture: "local-priority-fallback",
      fusedContent,
      fusionMethod: "priority-based",
      confidence,
      sourceDepartments: validOutputs.map((item) => item.department),
      rankingStrategy: this.fusionConfig.strategy,
      rankedCandidates: [],
      pairwiseComparisons: [],
      fusionTimestamp: new Date().toISOString(),
      fusionMetadata: {
        tokenUsage: Math.ceil(fusedContent.length / 4),
        latencyMs: 50,
        modelUsed: "local-fallback",
        reasoning: `API not available, using local priority-based fusion (${reason})`,
      },
    };
  }

  private buildFusionInputs(departmentOutputs: DepartmentResultCard[]): DepartmentOutputs {
    const fusionInputs: DepartmentOutputs = {};

    for (const card of departmentOutputs) {
      if (card.status !== "completed") {
        continue;
      }

      fusionInputs[card.department] = this.buildFusionInputText(card);
    }

    return fusionInputs;
  }

  private buildFusionInputText(card: DepartmentResultCard): string {
    return [
      `部门: ${card.department}`,
      `标题: ${card.title}`,
      `摘要: ${card.summary}`,
      `质量: ${card.qualityGrade} (${card.qualityScore})`,
      `源字段: ${card.sourceKeys.join(", ")}`,
      `规范化输出: ${this.safeStringify(card.normalizedOutput, 1500)}`,
    ].join("\n");
  }

  private safeStringify(value: Record<string, unknown>, maxLength: number): string {
    try {
      const raw = JSON.stringify(value, null, 2);
      if (!raw) {
        return "{}";
      }
      return raw.length > maxLength ? `${raw.slice(0, Math.max(0, maxLength - 3))}...` : raw;
    } catch {
      return "{}";
    }
  }

  private deriveFeasibilityScore(research?: DepartmentOutput, legal?: DepartmentOutput): number {
    const researchScore = this.clampScore(research?.score ?? 75);
    const legalScore = this.clampScore(legal?.score ?? 72);
    const combined = Math.round((researchScore * 0.7) + (legalScore * 0.3));
    return this.clampScore(combined);
  }

  private deriveFeasibilityVerdict(score: number, legal?: DepartmentOutput): "推进" | "谨慎" | "暂停" {
    const highRiskSignals = this.extractRiskCount(legal);
    if (score >= 75 && highRiskSignals <= 1) {
      return "推进";
    }
    if (score >= 55) {
      return "谨慎";
    }
    return "暂停";
  }

  private deriveBusinessValueRating(
    strategy?: DepartmentOutput,
    market?: DepartmentOutput,
  ): "高" | "中" | "低" {
    const hasStrategy = Boolean(strategy?.output?.businessModel && strategy?.output?.strategy);
    const hasMarket = Boolean(market?.output?.brand && market?.output?.plan);
    if (hasStrategy && hasMarket) {
      return "高";
    }
    if (hasStrategy || hasMarket) {
      return "中";
    }
    return "低";
  }

  private deriveRiskLevel(
    legal?: DepartmentOutput,
    market?: DepartmentOutput,
    sales?: DepartmentOutput,
  ): "低" | "中" | "高" {
    const riskCount = this.extractRiskCount(legal);
    const marketRisk = market ? 1 : 0;
    const salesRisk = sales ? 1 : 0;
    const total = riskCount + marketRisk + salesRisk;
    if (total >= 4) {
      return "高";
    }
    if (total >= 2) {
      return "中";
    }
    return "低";
  }

  private buildBusinessValueSummary(strategy?: DepartmentOutput, market?: DepartmentOutput): string {
    const valueProposition =
      this.pickString(strategy?.output?.businessModel, ["valueProposition", "revenueModel"]) ??
      this.pickString(strategy?.output?.strategy, ["positioning"]) ??
      "用标准化 AI 协作流程替代重复型人力工作";
    const marketScale =
      this.pickString(strategy?.output?.market, ["marketSize", "growthRate"]) ??
      this.pickString(market?.output?.brand, ["brandPosition"]) ??
      "市场规模与增长信号可继续验证";
    const valueExpression =
      this.pickString(market?.output?.brand, ["brandPosition"]) ??
      this.pickString(strategy?.output?.strategy, ["positioning"]) ??
      "定位清晰，可形成差异化主张";

    return `${valueProposition}。${marketScale}。${valueExpression}。`;
  }

  private buildRiskSummary(
    legal?: DepartmentOutput,
    market?: DepartmentOutput,
    sales?: DepartmentOutput,
  ): string {
    const legalIssues = this.collectStringList(legal?.output?.risks);
    const complianceIssues = this.collectStringList(legal?.output?.compliance);
    const marketSignals = [
      ...this.pickSignalStrings(market?.output?.strategy, ["positioning"]),
      ...this.pickSignalStrings(market?.output?.brand, ["brandPosition"]),
      ...this.pickSignalStrings(market?.output?.plan, ["campaignTheme"]),
    ];
    const salesSignals = [
      ...this.pickSignalStrings(sales?.output?.conversion, ["followUpSla"]),
      ...this.pickSignalStrings(sales?.output?.conversion, ["stages"]),
    ];

    const legalPart = legalIssues.length > 0 || complianceIssues.length > 0
      ? `合规风险：${[...legalIssues, ...complianceIssues].slice(0, 3).join("、")}`
      : "合规风险可控";
    const marketPart = marketSignals.length > 0
      ? `竞争风险：${marketSignals.slice(0, 2).join("、")}`
      : "竞争风险需继续验证";
    const salesPart = salesSignals.length > 0
      ? `转化风险：${salesSignals.slice(0, 2).join("、")}`
      : "转化风险可通过试点验证";

    const advice = this.buildRiskAdvice(legalIssues.length, marketSignals.length, salesSignals.length);
    return `${legalPart}；${marketPart}；${salesPart}。${advice}`;
  }

  private buildRiskAdvice(legalCount: number, marketCount: number, salesCount: number): string {
    if (legalCount >= 3) {
      return "建议先补齐数据合规与授权边界，再推进外部试点。";
    }
    if (marketCount >= 2 || salesCount >= 2) {
      return "建议先用小范围试点验证差异化和转化漏斗，再放大投放。";
    }
    return "建议保持当前节奏，重点监控合规与转化指标。";
  }

  private buildPriorityOrder(
    feasibilityScore: number,
    businessValueRating: "高" | "中" | "低",
    riskLevel: "低" | "中" | "高",
  ): string[] {
    const order: string[] = [];
    if (feasibilityScore >= 75) {
      order.push("先做原型试点，验证关键路径可执行性");
    } else {
      order.push("先补齐可行性假设和资源缺口");
    }

    if (businessValueRating === "高") {
      order.push("同步固化商业闭环和定价模型");
    } else {
      order.push("先验证市场规模和付费意愿");
    }

    if (riskLevel === "高") {
      order.push("优先处理合规、竞争和转化风险预案");
    } else if (riskLevel === "中") {
      order.push("建立风险监控清单并设定触发阈值");
    } else {
      order.push("按现有节奏推进并持续跟踪核心指标");
    }

    return order;
  }

  private buildNextStep(
    feasibilityVerdict: "推进" | "谨慎" | "暂停",
    businessValueRating: "高" | "中" | "低",
    riskLevel: "低" | "中" | "高",
    priorityOrder: string[],
  ): string {
    const firstStep = priorityOrder[0] ?? "继续推进验证";
    if (feasibilityVerdict === "暂停") {
      return `先暂停对外推进，补齐关键证据后再启动。建议先做：${firstStep}`;
    }
    if (businessValueRating === "高" && riskLevel !== "高") {
      return `进入小范围试点，优先验证商业闭环。建议先做：${firstStep}`;
    }
    return `受控推进下一轮验证，避免过早扩张。建议先做：${firstStep}`;
  }

  private extractRiskCount(legal?: DepartmentOutput): number {
    const riskOutput = legal?.output?.risks;
    if (!riskOutput || typeof riskOutput !== "object") {
      return 0;
    }
    const typedRiskOutput = riskOutput as Record<string, unknown>;
    const high = Array.isArray(typedRiskOutput.high) ? typedRiskOutput.high.length : 0;
    const medium = Array.isArray(typedRiskOutput.medium) ? typedRiskOutput.medium.length : 0;
    return high + Math.ceil(medium / 2);
  }

  private collectStringList(value: unknown): string[] {
    if (!value || typeof value !== "object") {
      return [];
    }
    const record = value as Record<string, unknown>;
    return Object.values(record).reduce<string[]>((accumulator, item) => {
      if (Array.isArray(item)) {
        accumulator.push(...item.filter((entry): entry is string => typeof entry === "string"));
        return accumulator;
      }
      if (typeof item === "string") {
        accumulator.push(item);
      }
      return accumulator;
    }, []);
  }

  private pickSignalStrings(value: unknown, keys: string[]): string[] {
    if (!value || typeof value !== "object") {
      return [];
    }

    const record = value as Record<string, unknown>;
    const signals: string[] = [];

    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        signals.push(candidate);
        continue;
      }

      if (Array.isArray(candidate)) {
        signals.push(...candidate.filter((entry): entry is string => typeof entry === "string"));
      }
    }

    return signals;
  }

  private pickString(value: unknown, keys: string[]): string | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate;
      }
    }
    return null;
  }

  private clampScore(score: number): number {
    if (Number.isNaN(score)) {
      return 0;
    }
    return Math.max(0, Math.min(100, score));
  }

  private buildOutputAttribution(input: ResultAggregationInput): OutputAttribution {
    const departments: OutputAttribution["departments"] = {};

    for (const output of input.outputs) {
      const attribution: NonNullable<OutputAttribution["departments"]>[typeof output.department] = {
        status: output.status === "failed" ? "failed" : "completed",
        sourceKeys: Object.keys(output.output),
      };

      if (output.score !== undefined) {
        attribution.score = output.score;
      }

      if (output.metadata !== undefined) {
        attribution.metadata = output.metadata;
      }

      departments[output.department] = attribution;
    }

    return {
      taskId: input.taskPlan.taskId,
      brain: {
        selected_experts: input.brainOutput.selected_experts ?? [],
        collaboration_plan: input.brainOutput.collaboration_plan ?? {},
        info_pool_hits: input.brainOutput.info_pool_hits ?? [],
        output_attribution: input.brainOutput.output_attribution ?? {},
        runtime_trace: input.brainOutput.runtime_trace ?? {},
      },
      runtime: {
        tier: input.taskPlan.tier,
        executionOrder: input.execution.executionOrder,
        succeeded: input.execution.succeeded,
        failed: input.execution.failed,
      },
      departments,
    };
  }

  private calculateQualityScore(
    departmentOutputs: DepartmentResultCard[],
    execution: ExecutionResult,
    trace: ExecutionEvent[],
  ): number {
    const completionRate = departmentOutputs.length === 0 ? 0 : departmentOutputs.filter((item) => item.status === "completed").length / departmentOutputs.length;
    const traceCoverage = trace.length === 0 ? 0 : Math.min(trace.length / Math.max(execution.executionOrder.length * 3, 1), 1);
    const failurePenalty = execution.failed.length > 0 ? Math.max(0, 1 - execution.failed.length * 0.15) : 1;
    const score = (completionRate * 0.55) + (traceCoverage * 0.25) + (failurePenalty * 0.2);
    return Math.round(score * 1000) / 1000;
  }

  private buildOutputSummary(output: Record<string, unknown>): string {
    const keys = Object.keys(output);
    if (keys.length === 0) {
      return "无结构化输出";
    }

    const preview = keys
      .slice(0, 3)
      .map((key) => `${key}=${this.stringifyValue(output[key])}`)
      .join("; ");

    return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
  }

  private stringifyValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return `[${value.length} items]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>).length} keys}`;
    }

    return String(value ?? "undefined");
  }

  private buildEnhancedExecutionTrace(
    traceEvents: ExecutionEvent[],
    execution: ExecutionResult,
  ): EnhancedExecutionTrace {
    const startedAt = execution.startedAt.getTime();
    const startedMap = new Map<DepartmentName, Date>();
    const finishedMap = new Map<DepartmentName, Date>();
    const errors = traceEvents
      .filter((event) => event.type === "department_failed" && event.department)
      .map((event) => ({
        department: event.department as DepartmentName,
        message: event.detail ?? "部门执行失败",
        timestamp: event.timestamp.toISOString(),
      }));

    for (const event of traceEvents) {
      if (!event.department) {
        continue;
      }
      if (event.type === "department_started") {
        startedMap.set(event.department, event.timestamp);
      }
      if (event.type === "department_succeeded" || event.type === "department_failed") {
        finishedMap.set(event.department, event.timestamp);
      }
    }

    const steps = execution.blockedByApproval
      ? []
      : execution.executionOrder.flat().map((department) => {
          const departmentStartedAt = startedMap.get(department)?.getTime() ?? startedAt;
          const departmentFinishedAt = finishedMap.get(department)?.getTime() ?? departmentStartedAt;
          return {
            name: `${department}_execution`,
            timestamp: new Date(departmentStartedAt).toISOString(),
            duration: Math.max(0, departmentFinishedAt - departmentStartedAt),
          };
        });

    return {
      events: traceEvents,
      enhanced: true,
      steps,
      errors,
    };
  }

  private buildAggregationMetadata(
    input: ResultAggregationInput,
    qualityAssessment: QualityAssessment,
    aggregationStartedAt: Date,
  ): AggregationMetadata {
    const aggregationTimestamp = new Date();
    const originalInput = this.buildOriginalInput(input);
    const normalizedOriginalInput = this.normalizeValue(originalInput);
    const serializedInput = JSON.stringify(normalizedOriginalInput);
    const inputHash = this.hashText(serializedInput);
    const inputSize = serializedInput.length;

    const departmentSnapshots = input.outputs.reduce<AggregationMetadata["departmentSnapshots"]>((accumulator, output) => {
      const normalizedOutput = this.normalizeOutput(output.output);
      const serializedOutput = JSON.stringify(normalizedOutput);
      accumulator[output.department] = {
        hash: this.hashText(serializedOutput),
        timestamp: aggregationTimestamp.toISOString(),
        size: serializedOutput.length,
      };
      return accumulator;
    }, {});

    const dataSource = this.extractDataSource(input.brainOutput);
    const inputReceivedTimestamp = this.parseTimestamp(
      input.brainOutput.input_received_timestamp,
      input.execution.startedAt,
    );
    const processingDurationMs = Math.max(0, aggregationTimestamp.getTime() - aggregationStartedAt.getTime());
    const resultVersion = this.extractResultVersion(input.brainOutput.result_version);
    const previousResultId = this.extractNullableString(input.brainOutput.previous_result_id);
    const exportTimestamp = this.parseOptionalTimestamp(input.brainOutput.export_timestamp);

    return {
      aggregationVersion: AGGREGATION_VERSION,
      summaryGenerationVersion: SUMMARY_VERSION,
      scoringVersion: SCORING_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      aggregationTimestamp: aggregationTimestamp.toISOString(),
      inputReceivedTimestamp: inputReceivedTimestamp.toISOString(),
      processingDurationMs,
      environment: "development",
      inputHash,
      inputSize,
      scoringMethod: `${SCORING_METHOD}|${qualityAssessment.ruleVersion}`,
      scoringWeights: SCORING_WEIGHTS,
      dataSource,
      parentExecutionId: this.extractNullableString(input.brainOutput.parent_execution_id),
      resultId: this.buildResultId(),
      resultVersion,
      previousResultId,
      diffAvailable: previousResultId !== null,
      exportFormat: input.brainOutput.export_format === "yaml" ? "yaml" : "json",
      exportTimestamp,
      departmentSnapshots,
      originalInput,
    };
  }

  private buildOriginalInput(
    input: ResultAggregationInput,
  ): AggregationMetadata["originalInput"] {
    const rawOriginal = input.brainOutput.original_input;
    return {
      query: (typeof rawOriginal?.query === "string" && rawOriginal.query.trim().length > 0)
        ? rawOriginal.query
        : input.taskPlan.bossInstruction,
      context: this.asRecord(rawOriginal?.context),
      options: this.asRecord(rawOriginal?.options),
    };
  }

  private normalizeOutput(output: Record<string, unknown>): Record<string, unknown> {
    return this.normalizeValue(output) as Record<string, unknown>;
  }

  private normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }
    if (!value || typeof value !== "object") {
      return value;
    }

    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const normalized: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      normalized[key] = this.normalizeValue(record[key]);
    }
    return normalized;
  }

  private hashText(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  private buildResultId(): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `result_${Date.now()}_${randomPart}`;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private extractDataSource(brainOutput: BrainRouterOutput): string {
    if (typeof brainOutput.data_source === "string" && brainOutput.data_source.trim().length > 0) {
      return brainOutput.data_source;
    }
    if (typeof brainOutput.source === "string" && brainOutput.source.trim().length > 0) {
      return brainOutput.source;
    }
    return "runtime";
  }

  private extractNullableString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    return value.trim().length > 0 ? value : null;
  }

  private extractResultVersion(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return 1;
  }

  private parseTimestamp(value: unknown, fallback: Date): Date {
    if (typeof value !== "string") {
      return fallback;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  private parseOptionalTimestamp(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }
}
