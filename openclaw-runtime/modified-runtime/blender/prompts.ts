import type { DepartmentOutputs, FusionStrategy, RankedCandidate } from "./types";
import { applyFusionStrategy } from "./fusion-strategies";

function stringifyOutput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  return trimmed;
}

export function getFusionPrompt(outputs: DepartmentOutputs, strategy: FusionStrategy): string {
  return getFusionPromptWithRanking(outputs, strategy, []);
}

export function getFusionPromptWithRanking(
  outputs: DepartmentOutputs,
  strategy: FusionStrategy,
  rankedCandidates: RankedCandidate[],
): string {
  const frame = applyFusionStrategy(outputs, strategy);
  const sections = frame.orderedDepartments
    .map((department) => ({
      department,
      content: outputs[department as keyof DepartmentOutputs],
    }))
    .filter((item): item is { department: string; content: string } => typeof item.content === "string" && item.content.trim().length > 0);

  const sectionsText = sections
    .map((item) => `## ${item.department.toUpperCase()}\n${stringifyOutput(item.content)}\n`)
    .join("\n");

  const rankingText = rankedCandidates.length > 0
    ? [
        "## PairRanker 排名",
        ...rankedCandidates.map((candidate) => {
          const scoreLine = `- ${candidate.rank}. ${candidate.department} | total=${candidate.totalScore.toFixed(4)} | base=${candidate.baseQuality.toFixed(4)} | pair=${candidate.pairScore.toFixed(4)} | wins=${candidate.wins}`;
          return `${scoreLine}\n${candidate.content.slice(0, 500)}`;
        }),
      ].join("\n")
    : "";

  return [
    "# Fusion Task",
    "",
    "你是 OPC runtime 的 GenFuser，负责结合 PairRanker 的排序结果，把多个部门输出融合成一个可执行、可审计、可回放的统一结果。",
    "",
    "## 融合输入",
    sectionsText || "(no department output)",
    rankingText,
    "",
    "## 融合策略",
    frame.instruction,
    "",
    "## 输出要求",
    "1. 保留每个部门的核心结论和关键证据。",
    "2. 优先吸收 PairRanker 排名前列的候选，低质量或重复内容应被压缩。",
    "3. 消除重复、冲突和空洞表述。",
    "4. 形成面向决策的统一叙述，不输出额外解释。",
    "5. 输出内容应适合被 runtime 直接存档或展示。",
    "",
    "## 融合后的结果",
  ].join("\n");
}
