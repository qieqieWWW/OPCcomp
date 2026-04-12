import type { DepartmentName, DepartmentOutput } from "../../department-agents/base-agent";
import type { DepartmentOutputs, FusionConfig, FusedResult } from "../blender";
import { LLMBlenderAdapter } from "../blender";
import type {
  AggregationMetadata,
  AggregatedRuntimeResult,
  BrainRouterOutput,
  EvidenceBoundOutput,
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

function nowIso(): string {
  return new Date().toISOString();
}

function isEvidenceStale(entry: EvidenceBoundOutput["evidence_registry"][number], nowMs: number): boolean {
  const collectedMs = Date.parse(entry.collected_at);
  if (!Number.isFinite(collectedMs)) {
    return false;
  }
  const ttl = Number(entry.freshness_ttl_hours);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return false;
  }
  return nowMs - collectedMs > ttl * 60 * 60 * 1000;
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
    const evidenceBoundOutput = this.buildEvidenceBoundOutput(input, cards, summary, fusedResult);
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
      evidenceBoundOutput,
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
      summary: this.buildOutputSummary(output.department, output.output),
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

  private buildOutputSummary(department: DepartmentName, output: Record<string, unknown>): string {
    const actions = this.extractActions(output);
    const joinList = (value: unknown, limit = 2): string => {
      if (!Array.isArray(value)) {
        return "";
      }
      const items = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => Boolean(item));
      return items.slice(0, limit).join("；");
    };

    if (department === "feasibility") {
      const score = this.readFeasibilityScore({ output } as DepartmentOutput);
      const recommendation = this.pickText(output, ["recommendation"]);
      const market = this.pickText(output, ["market_feasibility"]);
      const resource = this.pickText(output, ["resource_feasibility"]);
      const timeline = this.pickText(output, ["timeline_feasibility"]);
      const assumptions = joinList(output.assumptions, 2);
      return [
        `可行性评分 ${score}/100${recommendation ? `，建议 ${recommendation}` : ""}`,
        market ? `市场：${market}` : null,
        resource ? `资源：${resource}` : null,
        timeline ? `时间：${timeline}` : null,
        assumptions ? `关键假设：${assumptions}` : null,
      ].filter((item): item is string => Boolean(item)).join("；");
    }

    if (department === "risk") {
      const riskLevel = this.pickText(output, ["riskLevel"]) ?? "medium";
      const riskSummary = this.pickText(output, ["riskSummary"]);
      const blockers = joinList(output.blockers, 2);
      const mitigation = joinList(output.mitigation, 2);
      const goNoGo = this.pickText(output, ["goNoGo"]);
      return [
        `风险等级 ${riskLevel}`,
        riskSummary ? `判断：${riskSummary}` : null,
        blockers ? `阻塞项：${blockers}` : null,
        mitigation ? `缓解：${mitigation}` : null,
        goNoGo ? `决策：${goNoGo}` : null,
      ].filter((item): item is string => Boolean(item)).join("；");
    }

    if (department === "legal") {
      const risks = output.risks && typeof output.risks === "object" ? output.risks as Record<string, unknown> : {};
      const compliance = output.compliance && typeof output.compliance === "object" ? output.compliance as Record<string, unknown> : {};
      const ip = output.ip && typeof output.ip === "object" ? output.ip as Record<string, unknown> : {};
      const highRisks = joinList(risks.high, 2);
      const mediumRisks = joinList(risks.medium, 2);
      const complianceFindings = joinList(compliance.findings, 2);
      const remediation = joinList(compliance.remediation, 2);
      const filingPlan = joinList(ip.filingPlan, 2);
      return [
        highRisks ? `高风险：${highRisks}` : null,
        mediumRisks ? `中风险：${mediumRisks}` : null,
        complianceFindings ? `合规发现：${complianceFindings}` : null,
        remediation ? `整改：${remediation}` : null,
        filingPlan ? `知识产权：${filingPlan}` : null,
      ].filter((item): item is string => Boolean(item)).join("；");
    }

    if (department === "evidence") {
      const report = output.report && typeof output.report === "object" ? output.report as Record<string, unknown> : {};
      const executiveSummary = this.pickText(report, ["executiveSummary"]);
      const detailedAnalysis = this.pickText(report, ["detailedAnalysis"]);
      const recommendations = joinList(report.recommendations, 2);
      const nextSteps = joinList(report.nextSteps, 2);
      return [
        executiveSummary ?? this.pickText(output, ["summary", "technicalSummary"]),
        detailedAnalysis ? `分析：${detailedAnalysis}` : null,
        recommendations ? `建议：${recommendations}` : null,
        nextSteps ? `下一步：${nextSteps}` : null,
      ].filter((item): item is string => Boolean(item)).join("；");
    }

    if (actions.length > 0) {
      return actions.slice(0, 2).join("；");
    }
    const keys = Object.keys(output);
    if (keys.length === 0) {
      return "无结构化输出";
    }
    return `包含字段：${keys.slice(0, 4).join("、")}`;
  }

  private buildEvidenceBoundOutput(
    input: ResultAggregationInput,
    cards: DepartmentResultCard[],
    summary: ExecutiveSummary,
    fusedResult: FusedResult | null,
  ): EvidenceBoundOutput {
    const collectedAt = nowIso();
    const evidenceRegistry: EvidenceBoundOutput["evidence_registry"] = [];
    const evidenceByDepartment: Partial<Record<DepartmentName, string>> = {};

    for (const card of cards) {
      const evidenceId = this.buildEvidenceId(
        "dataset",
        `department:${card.department}`,
        `${card.title}|${card.summary}|${safeStringify(card.normalizedOutput).slice(0, 240)}`,
        collectedAt,
      );
      evidenceRegistry.push({
        evidence_id: evidenceId,
        evidence_type: "dataset",
        source: `department:${card.department}`,
        source_label: `${card.department} 部门输出`,
        collected_at: collectedAt,
        freshness_ttl_hours: 72,
        snippet: card.summary,
        checksum: hashText(safeStringify(card.normalizedOutput)),
      });
      evidenceByDepartment[card.department] = evidenceId;
    }

    const claims: EvidenceBoundOutput["claims"] = [];
    const primaryEvidenceIds = [
      evidenceByDepartment.evidence,
      evidenceByDepartment.feasibility,
      evidenceByDepartment.risk,
      evidenceByDepartment.legal,
    ].filter((item): item is string => Boolean(item));

    const addClaim = (payload: {
      text: string;
      evidence_ids: string[];
      confidence: number;
      scope: EvidenceBoundOutput["claims"][number]["scope"];
      decision_type: EvidenceBoundOutput["claims"][number]["decision_type"];
    }): void => {
      const text = payload.text.trim();
      const evidenceIds = Array.from(new Set(payload.evidence_ids.filter((item): item is string => Boolean(item))));
      if (!text || evidenceIds.length === 0) {
        return;
      }

      claims.push({
        claim_id: `CLM-${String(claims.length + 1).padStart(3, "0")}`,
        text,
        evidence_ids: evidenceIds,
        confidence: Math.max(0, Math.min(1, payload.confidence)),
        scope: payload.scope,
        decision_type: payload.decision_type,
      });
    };

    if (summary.overview.trim()) {
      addClaim({
        text: summary.overview.trim(),
        evidence_ids: primaryEvidenceIds.slice(0, Math.max(1, primaryEvidenceIds.length)),
        confidence: Math.max(0.1, Math.min(0.99, summary.qualityScore / 100)),
        scope: "short_term",
        decision_type: "estimate",
      });
    }

    if (summary.businessValue.trim()) {
      addClaim({
        text: summary.businessValue.trim(),
        evidence_ids: [evidenceByDepartment.feasibility, evidenceByDepartment.evidence].filter((item): item is string => Boolean(item)),
        confidence: 0.76,
        scope: "short_term",
        decision_type: "estimate",
      });
    }

    if (summary.riskView.trim()) {
      addClaim({
        text: summary.riskView.trim(),
        evidence_ids: [evidenceByDepartment.risk, evidenceByDepartment.legal].filter((item): item is string => Boolean(item)),
        confidence: 0.74,
        scope: "short_term",
        decision_type: "estimate",
      });
    }

    if (summary.nextStep.trim()) {
      addClaim({
        text: summary.nextStep.trim(),
        evidence_ids: [evidenceByDepartment.legal, evidenceByDepartment.risk, evidenceByDepartment.feasibility].filter((item): item is string => Boolean(item)),
        confidence: 0.82,
        scope: "short_term",
        decision_type: "recommendation",
      });
    }

    const actions: EvidenceBoundOutput["actions"] = [];
    for (let index = 0; index < Math.min(3, summary.priorityOrder.length); index += 1) {
      const actionText = summary.priorityOrder[index];
      if (!actionText) {
        continue;
      }
      const evidenceIds = index === 0
        ? [evidenceByDepartment.feasibility].filter((item): item is string => Boolean(item))
        : [evidenceByDepartment.risk, evidenceByDepartment.legal].filter((item): item is string => Boolean(item));
      actions.push({
        action_id: `ACT-${String(index + 1).padStart(3, "0")}`,
        text: actionText,
        owner: index === 0 ? "feasibility" : index === 1 ? "risk" : "legal",
        due_hint: index === 0 ? "T+3d" : index === 1 ? "T+5d" : "T+7d",
        depends_on_evidence_ids: evidenceIds,
      });
    }

    const conflicts: EvidenceBoundOutput["conflicts"] = [];
    if (input.execution.failed.length > 0) {
      conflicts.push({
        conflict_id: "CFL-001",
        claim_ids: claims.slice(0, 2).map((item) => item.claim_id),
        evidence_ids: primaryEvidenceIds.slice(0, 2),
        reason: `${input.execution.failed.length} 个部门执行失败，需要复核输出一致性。`,
        resolution: "补齐失败部门输出后重新聚合。",
      });
    }

    if (!fusedResult && cards.length > 0) {
      conflicts.push({
        conflict_id: "CFL-002",
        claim_ids: claims.slice(0, 1).map((item) => item.claim_id),
        evidence_ids: primaryEvidenceIds.slice(0, 1),
        reason: "融合层未生成统一结果，说明多部门证据尚未达成一致。",
        resolution: "优先补充统一总结层，再进入用户侧主回复。",
      });
    }

    const evidenceIdSet = new Set(evidenceRegistry.map((item) => item.evidence_id));
    const missingEvidenceLink = claims.some((item) => item.evidence_ids.some((id) => !evidenceIdSet.has(id)));
    const nowMs = Date.now();
    const staleEvidence = evidenceRegistry.some((entry) => isEvidenceStale(entry, nowMs));
    const noEvidence = claims.length === 0 || claims.some((item) => item.evidence_ids.length === 0) || missingEvidenceLink;
    const conflictPresent = conflicts.length > 0;
    const degraded = noEvidence || staleEvidence || conflictPresent;
    const degradeReason = noEvidence
      ? "NO_EVIDENCE"
      : conflictPresent
        ? "EVIDENCE_CONFLICT"
        : staleEvidence
          ? "STALE_EVIDENCE"
          : "";
    const coverage = claims.length === 0
      ? 0
      : Math.round((claims.filter((item) => item.evidence_ids.length > 0).length / claims.length) * 10000) / 10000;

    return {
      claims,
      evidence_registry: evidenceRegistry,
      conflicts,
      actions,
      output_meta: {
        coverage,
        conflict_present: conflictPresent,
        degraded,
        degrade_reason: degradeReason,
      },
    };
  }

  private buildEvidenceId(evidenceType: EvidenceBoundOutput["evidence_registry"][number]["evidence_type"], source: string, snippet: string, collectedAt: string): string {
    const seed = `${evidenceType}|${source}|${snippet}`;
    return `EVD-${evidenceType}-${collectedAt.slice(0, 10).replace(/-/g, "")}-${hashText(seed).slice(1, 9)}`;
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
    const feasibilityOutput = lookup.feasibility?.output ?? {};
    const riskOutput = lookup.risk?.output ?? {};
    const legalOutput = lookup.legal?.output ?? {};
    const evidenceOutput = lookup.evidence?.output ?? {};

    const feasibilityMarket = this.pickText(feasibilityOutput, ["market_feasibility"]);
    const feasibilityResource = this.pickText(feasibilityOutput, ["resource_feasibility"]);
    const feasibilityTimeline = this.pickText(feasibilityOutput, ["timeline_feasibility"]);
    const feasibilityRecommendation = this.pickText(feasibilityOutput, ["recommendation"]);
    const feasibilityAssumptions = this.pickList(feasibilityOutput, ["assumptions"], 2);

    const riskSummary = this.pickText(riskOutput, ["riskSummary", "goNoGo"]);
    const riskBlockers = this.pickList(riskOutput, ["blockers"], 2);
    const legalFindings = this.pickList(legalOutput, ["compliance", "findings"], 2);
    const legalRemediation = this.pickList(legalOutput, ["compliance", "remediation"], 2);
    const evidenceSummary = this.pickText(evidenceOutput, ["report", "executiveSummary", "summary"])
      ?? this.pickText(evidenceOutput, ["report", "detailedAnalysis"])
      ?? this.pickText(evidenceOutput, ["summary"]);

    const overview = [
      `已完成${completedCount}个部门的分析${failedCount > 0 ? `，其中${failedCount}个部门未完成` : ""}。`,
      `可行性评分 ${feasibilityScore}/100，建议 ${feasibilityVerdict}推进。`,
      `质量评分 ${qualityScore}/100，评级 ${gradeFromScore(qualityScore)}。`,
      `风险等级 ${riskLevel}。`,
    ].join(" ");

    const nextStep = this.firstText([
      this.extractActions(lookup.legal?.output ?? {})[0],
      this.extractActions(lookup.risk?.output ?? {})[0],
      this.extractActions(lookup.feasibility?.output ?? {})[0],
      legalRemediation[0],
      riskBlockers[0],
      feasibilityAssumptions[0],
    ]) ?? "整理关键假设并启动为期 2 周的最小验证计划。";

    const highlights = [
      `可行性评分 ${feasibilityScore}/100，建议 ${feasibilityVerdict}`,
      `质量评分 ${qualityScore}/100，评级 ${gradeFromScore(qualityScore)}`,
      `风险等级 ${riskLevel}`,
      feasibilityMarket ? `市场判断：${feasibilityMarket}` : null,
      feasibilityResource ? `资源判断：${feasibilityResource}` : null,
      feasibilityTimeline ? `时间判断：${feasibilityTimeline}` : null,
      riskSummary ? `风险摘要：${riskSummary}` : null,
      evidenceSummary ? `研究摘要：${evidenceSummary}` : null,
    ].filter((item): item is string => Boolean(item));

    const businessValue = [
      this.pickText(feasibilityOutput, ["market_feasibility", "resource_feasibility"]),
      this.pickText(evidenceOutput, ["report", "executiveSummary"]),
    ].filter((item): item is string => Boolean(item)).join("；") || "商业价值待进一步量化。";

    const riskView = [
      riskSummary,
      legalFindings.length > 0 ? `合规关注：${legalFindings.join("；")}` : null,
      legalRemediation.length > 0 ? `整改建议：${legalRemediation.join("；")}` : null,
      riskBlockers.length > 0 ? `阻塞项：${riskBlockers.join("；")}` : null,
    ].filter((item): item is string => Boolean(item)).join(" ") || "风险已纳入后续评估。";

    const priorityOrder = this.pickList(legalOutput, ["compliance", "remediation"], 1)
      .concat(this.pickList(riskOutput, ["mitigation"], 1))
      .concat(this.pickList(feasibilityOutput, ["assumptions"], 1))
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 3);

    if (priorityOrder.length === 0) {
      priorityOrder.push("验证核心假设", "控制合规风险", "推进最小可行产品");
    }

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
      highlights,
      businessValue,
      riskView,
      priorityOrder,
      nextStep,
      warnings: [
        ...(failedCount > 0 ? [`${failedCount} 个部门执行失败，需复盘后重试。`] : []),
        ...(feasibilityScore < 60 ? ["可行性评分偏低，建议先做最小验证而非直接放大投入。"] : []),
      ],
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

  private pickList(output: Record<string, unknown> | undefined, keys: string[], limit = 2): string[] {
    if (!output) {
      return [];
    }

    let current: unknown = output;
    for (const key of keys) {
      if (!current || typeof current !== "object") {
        return [];
      }
      current = (current as Record<string, unknown>)[key];
    }

    if (!Array.isArray(current)) {
      return [];
    }

    return current
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => Boolean(item))
      .slice(0, limit);
  }

  private firstText(values: Array<string | null | undefined>): string | null {
    for (const value of values) {
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
