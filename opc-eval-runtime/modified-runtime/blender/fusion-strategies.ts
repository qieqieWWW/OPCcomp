import type { DepartmentOutputs, FusionStrategy } from "./types";

export interface StrategyFrame {
  strategy: FusionStrategy;
  orderedDepartments: string[];
  emphasis: Record<string, number>;
  instruction: string;
}

const DEFAULT_ORDER = ["evidence", "feasibility", "risk", "legal"] as const;

const STRATEGY_FRAMES: Record<FusionStrategy, StrategyFrame> = {
  consensus: {
    strategy: "consensus",
    orderedDepartments: [...DEFAULT_ORDER],
    emphasis: {
      evidence: 1,
      feasibility: 1,
      risk: 1,
      legal: 1,
    },
    instruction: "优先保留四个部门共同认可的观点，冲突部分用更明确的结论或并列说明处理。",
  },
  weighted: {
    strategy: "weighted",
    orderedDepartments: [...DEFAULT_ORDER],
    emphasis: {
      evidence: 1.2,
      feasibility: 1.2,
      risk: 1.1,
      legal: 1.1,
    },
    instruction: "优先融合 evidence 与 feasibility 的核心判断，并用 risk、legal 做校验和补充。",
  },
  priority: {
    strategy: "priority",
    orderedDepartments: [...DEFAULT_ORDER],
    emphasis: {
      evidence: 1.3,
      feasibility: 1.2,
      risk: 1.1,
      legal: 1.1,
    },
    instruction: "严格遵循 evidence -> feasibility -> risk -> legal 的顺序，前置部门的信息优先进入最终结论。",
  },
  comprehensive: {
    strategy: "comprehensive",
    orderedDepartments: [...DEFAULT_ORDER],
    emphasis: {
      evidence: 1,
      feasibility: 1,
      risk: 1,
      legal: 1,
    },
    instruction: "尽可能完整保留所有部门的重要观点，允许更长的综合输出，但避免重复堆砌。",
  },
};

export function applyFusionStrategy(outputs: DepartmentOutputs, strategy: FusionStrategy): StrategyFrame {
  const frame = STRATEGY_FRAMES[strategy] ?? STRATEGY_FRAMES.consensus;
  const present = frame.orderedDepartments.filter((department) => Boolean(outputs[department as keyof DepartmentOutputs]));

  return {
    ...frame,
    orderedDepartments: present.length > 0 ? present : [...DEFAULT_ORDER],
  };
}
