import runtime, { OpenClawRuntime } from "./modified-runtime/runtime";

export { OpenClawRuntime, ResultAggregator } from "./modified-runtime/index";
export { runtime } from "./modified-runtime/runtime";
export { LLMBlenderAdapter, applyFusionStrategy, getFusionPrompt, getFusionPromptWithRanking } from "./modified-runtime/index";
export type {
	BlenderAdapter,
	DepartmentOutputs,
	FusionConfig,
	FusionMethod,
	FusionStrategy,
	FusedResult,
	PairwiseComparison,
	RankedCandidate,
} from "./modified-runtime/index";
export type { AggregatedRuntimeResult, BrainRouterOutput, ExecutiveSummary, OutputAttribution } from "./modified-runtime/index";

export default runtime;
