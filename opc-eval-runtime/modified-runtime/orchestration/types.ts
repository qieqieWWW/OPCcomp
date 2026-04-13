import type { DepartmentName } from "../../department-agents/base-agent";
import type { FusedResult } from "../blender";

export type TierLevel = "L1" | "L2" | "L3";
export type ApprovalStatus = "not_required" | "approved" | "pending" | "rejected";

export interface TaskPlanContextData {
  infoPoolHits?: Array<Record<string, unknown>>;
  selectedExperts?: Array<Record<string, unknown>>;
  outputAttribution?: Record<string, unknown>;
  runtimeTrace?: Record<string, unknown>;
  rawBrainOutput?: Record<string, unknown>;
}

export interface TaskPlan {
  taskId: string;
  bossInstruction: string;
  tier: TierLevel;
  departments: DepartmentName[];
  dependencies: Partial<Record<DepartmentName, DepartmentName[]>>;
  contextData: TaskPlanContextData;
}

export interface ExecutionResult {
  taskId: string;
  succeeded: DepartmentName[];
  failed: DepartmentName[];
  executionOrder: DepartmentName[][];
  approvalRequired: boolean;
  approvalStatus: ApprovalStatus;
  blockedByApproval: boolean;
  approvalDetail?: string;
  startedAt: Date;
  finishedAt: Date;
}

export interface ExecutionEvent {
  taskId: string;
  department?: DepartmentName;
  type:
    | "task_started"
    | "task_finished"
    | "approval_required"
    | "approval_granted"
    | "approval_blocked"
    | "department_started"
    | "department_succeeded"
    | "department_failed";
  timestamp: Date;
  detail?: string;
}

export interface DepartmentResultCard {
  department: DepartmentName;
  status: "completed" | "failed";
  title: string;
  summary: string;
  sourceKeys: string[];
  output: Record<string, unknown>;
  rawOutput: Record<string, unknown>;
  normalizedOutput: Record<string, unknown>;
  qualityScore: number;
  qualityGrade: QualityGrade;
  qualityMetrics: DepartmentQualityMetrics;
}

export type QualityGrade = "A" | "B" | "C" | "D";

export interface DepartmentQualityMetrics {
  completeness: number;
  depth: number;
  consistency: number;
  operability: number;
}

export interface DepartmentQualityScore {
  department: DepartmentName;
  score: number;
  grade: QualityGrade;
  metrics: DepartmentQualityMetrics;
  notes: string[];
}

export interface QualityAssessment {
  ruleVersion: string;
  scoredAt: string;
  overallScore: number;
  overallGrade: QualityGrade;
  departmentScores: Partial<Record<DepartmentName, DepartmentQualityScore>>;
  improvementSuggestions: string[];
  rawData: {
    weights: Record<DepartmentName, number>;
    departmentScores: Record<DepartmentName, DepartmentQualityScore>;
  };
}

export interface DepartmentSnapshot {
  hash: string;
  timestamp: string;
  size: number;
}

export interface AggregationMetadata {
  aggregationVersion: string;
  summaryGenerationVersion: string;
  scoringVersion: string;
  runtimeVersion: string;
  aggregationTimestamp: string;
  inputReceivedTimestamp: string;
  processingDurationMs: number;
  environment: "development" | "production";
  nodeVersion?: string;
  inputHash: string;
  inputSize: number;
  scoringMethod: string;
  scoringWeights: {
    completeness: number;
    depth: number;
    consistency: number;
    actionable: number;
  };
  dataSource: string;
  parentExecutionId: string | null;
  resultId: string;
  resultVersion: number;
  previousResultId: string | null;
  diffAvailable: boolean;
  exportFormat: "json" | "yaml";
  exportTimestamp: string | null;
  departmentSnapshots: Partial<Record<DepartmentName, DepartmentSnapshot>>;
  originalInput: {
    query: string;
    context: Record<string, unknown>;
    options: Record<string, unknown>;
  };
}

export interface ExecutionTraceStep {
  name: string;
  timestamp: string;
  duration: number;
}

export interface ExecutionTraceError {
  department: DepartmentName;
  message: string;
  timestamp: string;
}

export interface EnhancedExecutionTrace {
  events: ExecutionEvent[];
  enhanced: boolean;
  steps: ExecutionTraceStep[];
  errors: ExecutionTraceError[];
}

export interface ExecutiveSummary {
  headline: string;
  overview: string;
  departmentCount: number;
  completedCount: number;
  failedCount: number;
  qualityScore: number;
  feasibilityScore: number;
  feasibilityVerdict: "推进" | "谨慎" | "暂停";
  businessValueRating: "高" | "中" | "低";
  riskLevel: "低" | "中" | "高";
  highlights: string[];
  businessValue: string;
  riskView: string;
  priorityOrder: string[];
  nextStep: string;
  warnings: string[];
}

export interface EvidenceClaim {
  claim_id: string;
  text: string;
  evidence_ids: string[];
  confidence: number;
  scope: "short_term" | "mid_term" | "long_term";
  decision_type: "fact" | "estimate" | "recommendation" | "factual" | "reference" | "contextual";
}

export interface EvidenceRegistryEntry {
  evidence_id: string;
  evidence_type: "dataset" | "rule" | "simulation" | "web" | "profile" | "knowledge_graph" | "info_pool";
  source: string;
  source_label: string;
  collected_at: string;
  freshness_ttl_hours: number;
  snippet: string;
  checksum?: string;
  /** 真实证据的扩展元数据（KG关系/Web来源等），仅 knowledge_graph/web/info_pool 类型使用 */
  metadata?: Record<string, unknown>;
}

export interface EvidenceConflict {
  conflict_id: string;
  claim_ids: string[];
  evidence_ids: string[];
  reason: string;
  resolution: string;
}

export interface EvidenceAction {
  action_id: string;
  text: string;
  owner: string;
  due_hint: string;
  depends_on_evidence_ids: string[];
}

export interface EvidenceBoundOutput {
  claims: EvidenceClaim[];
  evidence_registry: EvidenceRegistryEntry[];
  conflicts: EvidenceConflict[];
  actions: EvidenceAction[];
  output_meta: {
    coverage: number;
    conflict_present: boolean;
    degraded: boolean;
    degrade_reason: string;
  };
}

export interface OutputAttribution {
  taskId: string;
  brain: Record<string, unknown>;
  runtime: Record<string, unknown>;
  departments: Partial<
    Record<
      DepartmentName,
      {
        status: "completed" | "failed";
        sourceKeys: string[];
        score?: number;
        metadata?: Record<string, unknown>;
      }
    >
  >;
}

export interface AggregatedRuntimeResult {
  taskId: string;
  bossInstruction: string;
  tier: TierLevel;
  executiveSummary: ExecutiveSummary;
  qualityScores: QualityAssessment;
  qualityAssessment: QualityAssessment;
  summary: string;
  departmentOutputs: DepartmentResultCard[];
  departments: DepartmentResultCard[];
  succeeded: DepartmentName[];
  failed: DepartmentName[];
  approvalRequired: boolean;
  approvalStatus: ApprovalStatus;
  blockedByApproval: boolean;
  executionOrder: DepartmentName[][];
  executionTrace: EnhancedExecutionTrace;
  trace: ExecutionEvent[];
  outputAttribution: OutputAttribution;
  evidenceBoundOutput?: EvidenceBoundOutput;
  fusedResult: FusedResult | null;
  metadata: AggregationMetadata;
  startedAt: Date;
  finishedAt: Date;
  brainOutput: BrainRouterOutput;
}

export interface BrainRouterOutput {
  small_model?: {
    tier?: string;
    score?: number;
    backend?: string;
    backend_reason?: string;
  };
  selected_experts?: Array<Record<string, unknown>>;
  collaboration_plan?: {
    edges?: Array<Record<string, unknown>>;
  };
  info_pool_hits?: Array<Record<string, unknown>>;
  output_attribution?: Record<string, unknown>;
  runtime_trace?: Record<string, unknown>;
  source?: string;
  data_source?: string;
  parent_execution_id?: string | null;
  previous_result_id?: string | null;
  result_version?: number;
  export_format?: "json" | "yaml";
  export_timestamp?: string | null;
  input_received_timestamp?: string;
  original_input?: {
    query?: string;
    context?: Record<string, unknown>;
    options?: Record<string, unknown>;
  };
  [key: string]: unknown;
}
