import { OpenClawRuntime } from "../runtime";
import { ResultAggregator } from "../aggregation";

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

const BLENDER_API_KEY = readEnv("BLENDER_API_KEY");
const BLENDER_MODEL = readEnv("BLENDER_MODEL") ?? "gpt-4";
const BLENDER_BASE_URL = readEnv("BLENDER_BASE_URL");
const SHOW_FULL_FUSION = readEnv("SHOW_FULL_FUSION") === "true";

console.log(`\n${"=".repeat(80)}`);
console.log("Running OPCcomp Modified Runtime Smoke Test");
console.log("=".repeat(80));
console.log("Configuration:");
console.log(`  Blender API Key: ${BLENDER_API_KEY ? "provided" : "not provided (using local fallback)"}`);
console.log(`  Blender Model: ${BLENDER_MODEL}`);
console.log("  Fusion Strategy: consensus");
console.log(`${"=".repeat(80)}\n`);

async function main(): Promise<void> {
  const fusionConfig = {
    strategy: "consensus" as const,
    temperature: 0.7,
    maxTokens: 2000,
    includeReasoning: false,
  };

  const aggregatorConfig: ConstructorParameters<typeof ResultAggregator>[0] = {
    fusionConfig,
    blenderModel: BLENDER_MODEL,
  };

  if (BLENDER_API_KEY) {
    aggregatorConfig.blenderApiKey = BLENDER_API_KEY;
  }
  if (BLENDER_BASE_URL) {
    aggregatorConfig.blenderBaseUrl = BLENDER_BASE_URL;
  }

  const aggregator = new ResultAggregator(aggregatorConfig);

  const runtime = new OpenClawRuntime({ aggregator });

  const brainOutput = {
    taskId: "demo-task-001",
    bossInstruction: "请给一个AI创业项目做从调研到销售转化的完整执行方案",
    small_model: { tier: "L2" },
    selected_experts: [
      { name: "research_agent" },
      { name: "strategy_agent" },
      { name: "legal_agent" },
      { name: "market_agent" },
      { name: "sales_agent" },
    ],
    collaboration_plan: {
      edges: [
        { from: "research_agent", to: "strategy_agent" },
        { from: "research_agent", to: "legal_agent" },
        { from: "strategy_agent", to: "market_agent" },
        { from: "legal_agent", to: "market_agent" },
        { from: "market_agent", to: "sales_agent" },
      ],
    },
    info_pool_hits: [{ id: "hit-001", score: 0.92 }],
    output_attribution: { source: "smoke-test" },
    runtime_trace: { source: "smoke-test" },
  };

  const started = Date.now();
  const result = await runtime.execute(brainOutput);
  const elapsedMs = Date.now() - started;

  const traceCounts = result.trace.reduce<Record<string, number>>((acc, event) => {
    const key = event.type;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const metrics = {
    taskId: result.taskId,
    tier: result.tier,
    elapsedMs,
    departmentTotal: result.departments.length,
    succeeded: result.succeeded.length,
    failed: result.failed.length,
    traceTotal: result.trace.length,
    traceCounts,
  };

  console.log("=== RUNTIME SMOKE METRICS ===");
  console.log(JSON.stringify(metrics, null, 2));

  console.log("\n=== EXECUTIVE SUMMARY ===");
  console.log(JSON.stringify(result.executiveSummary, null, 2));

  console.log("\n=== QUALITY ASSESSMENT ===");
  console.log(JSON.stringify(result.qualityAssessment, null, 2));

  console.log("\n=== OUTPUT ATTRIBUTION ===");
  console.log(JSON.stringify(result.outputAttribution, null, 2));

  console.log("\n=== METADATA (STAGE 3) ===");
  console.log(
    JSON.stringify(
      {
        aggregationVersion: result.metadata.aggregationVersion,
        summaryGenerationVersion: result.metadata.summaryGenerationVersion,
        scoringVersion: result.metadata.scoringVersion,
        runtimeVersion: result.metadata.runtimeVersion,
        aggregationTimestamp: result.metadata.aggregationTimestamp,
        inputHash: result.metadata.inputHash,
        inputSize: result.metadata.inputSize,
        dataSource: result.metadata.dataSource,
        resultId: result.metadata.resultId,
        resultVersion: result.metadata.resultVersion,
        previousResultId: result.metadata.previousResultId,
        diffAvailable: result.metadata.diffAvailable,
      },
      null,
      2,
    ),
  );

  console.log("\n=== ENHANCED TRACE (STAGE 3) ===");
  console.log(
    JSON.stringify(
      {
        enhanced: result.executionTrace.enhanced,
        stepCount: result.executionTrace.steps.length,
        errorCount: result.executionTrace.errors.length,
        stepsHead: result.executionTrace.steps.slice(0, 5),
        errors: result.executionTrace.errors,
      },
      null,
      2,
    ),
  );

  console.log(`\n${"=".repeat(80)}`);
  console.log("FUSED RESULT (DIRECTION A - LLM-BLENDER)");
  console.log("=".repeat(80));

  if (result.fusedResult) {
    const fused = result.fusedResult;
    console.log(`Type: ${fused.type}`);
    console.log(`Method: ${fused.fusionMethod}`);
    console.log(`Confidence: ${(fused.confidence * 100).toFixed(1)}%`);
    console.log(`Sources: ${fused.sourceDepartments.join(", ")}`);
    console.log(`Timestamp: ${fused.fusionTimestamp}`);
    if (fused.fusionMetadata) {
      console.log(`Latency: ${fused.fusionMetadata.latencyMs ?? "N/A"}ms`);
      console.log(`Tokens: ${fused.fusionMetadata.tokenUsage ?? "N/A"}`);
      console.log(`Model: ${fused.fusionMetadata.modelUsed ?? "N/A"}`);
      if (fused.fusionMetadata.reasoning) {
        console.log(`Reasoning: ${fused.fusionMetadata.reasoning}`);
      }
    }

    const preview = fused.fusedContent.length > 500
      ? `${fused.fusedContent.slice(0, 500)}...`
      : fused.fusedContent;
    console.log(`\n${"-".repeat(80)}`);
    console.log("Fused Content Preview (first 500 chars)");
    console.log("-".repeat(80));
    console.log(preview);
    console.log("-".repeat(80));

    if (SHOW_FULL_FUSION) {
      console.log(`\n${"=".repeat(80)}`);
      console.log("FULL FUSED CONTENT");
      console.log("=".repeat(80));
      console.log(fused.fusedContent);
      console.log(`${"=".repeat(80)}\n`);
    }
  } else {
    console.log("Fusion failed or was skipped.");
  }

  console.log("\n=== EXECUTION ORDER ===");
  console.log(JSON.stringify(result.executionOrder));

  console.log("\n=== DEPARTMENT CARDS ===");
  for (const card of result.departmentOutputs) {
    console.log(`- ${card.department}: ${card.status} | ${card.qualityGrade} ${card.qualityScore} | ${card.summary}`);
  }

  console.log("\n=== TRACE HEAD (first 8) ===");
  for (const event of result.trace.slice(0, 8)) {
    const dept = event.department ? ` [${event.department}]` : "";
    const detail = event.detail ? ` | ${event.detail}` : "";
    console.log(`${event.type}${dept} @ ${event.timestamp.toISOString()}${detail}`);
  }
}

main().catch((error: unknown) => {
  console.error("Runtime smoke test failed:", error);
  throw error;
});
