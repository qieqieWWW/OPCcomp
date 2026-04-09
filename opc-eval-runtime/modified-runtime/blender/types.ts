export interface DepartmentOutputs {
  evidence?: string;
  feasibility?: string;
  risk?: string;
  legal?: string;
}

export type FusionStrategy = "consensus" | "weighted" | "priority" | "comprehensive";

export type FusionType = "llm-based-fusion" | "local-fallback-fusion" | "rule-based-fusion";

export type FusionMethod = FusionStrategy | "pairranked-fusion" | "llm-genfuser" | "priority-based" | "rule-based-fusion";

export interface FusionConfig {
  strategy: FusionStrategy;
  temperature?: number;
  maxTokens?: number;
  includeReasoning?: boolean;
  topK?: number;
}

export interface RankedCandidate {
  department: keyof DepartmentOutputs;
  rank: number;
  wins: number;
  baseQuality: number;
  pairScore: number;
  totalScore: number;
  contentLength: number;
  content: string;
}

export interface PairwiseComparison {
  leftDepartment: keyof DepartmentOutputs;
  rightDepartment: keyof DepartmentOutputs;
  winnerDepartment: keyof DepartmentOutputs;
  leftScore: number;
  rightScore: number;
}

export interface FusedResult {
  type: FusionType;
  architecture?: "pairranker+genfuser" | "local-priority-fallback";
  fusedContent: string;
  fusionMethod: FusionMethod;
  confidence: number;
  sourceDepartments: string[];
  rankingStrategy?: FusionStrategy;
  rankedCandidates?: RankedCandidate[];
  pairwiseComparisons?: PairwiseComparison[];
  fusionTimestamp: string;
  fusionMetadata?: {
    tokenUsage?: number;
    latencyMs?: number;
    modelUsed?: string;
    rankerModel?: string;
    fuserModel?: string;
    rankingSummary?: string;
    reasoning?: string;
  };
}

export interface BlenderAdapter {
  fuse(outputs: DepartmentOutputs, config?: FusionConfig): Promise<FusedResult>;
  setApiKey(apiKey: string): void;
  setModel(model: string): void;
}
