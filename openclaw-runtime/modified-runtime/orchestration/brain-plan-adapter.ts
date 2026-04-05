import type { DepartmentName } from "../../department-agents/base-agent";
import type { BrainRouterOutput, TaskPlan, TierLevel } from "./types";

const AGENT_TO_DEPARTMENT: Record<string, DepartmentName> = {
  research_agent: "research",
  strategy_agent: "strategy",
  legal_agent: "legal",
  market_agent: "market",
  sales_agent: "sales",
};

const DEFAULT_DEPS: Record<DepartmentName, DepartmentName[]> = {
  research: [],
  strategy: ["research"],
  legal: ["research"],
  market: ["strategy", "legal"],
  sales: ["market"],
};

export class BrainPlanAdapter {
  fromRouterOutput(taskId: string, bossInstruction: string, brain: BrainRouterOutput): TaskPlan {
    const tier = this.normalizeTier(String(brain.small_model?.tier ?? "L2"));

    const departments = this.extractDepartments(brain);
    const dependencies = this.extractDependencies(brain, departments);

    return {
      taskId,
      bossInstruction,
      tier,
      departments,
      dependencies,
      contextData: {
        infoPoolHits: (brain.info_pool_hits ?? []) as Array<Record<string, unknown>>,
        selectedExperts: (brain.selected_experts ?? []) as Array<Record<string, unknown>>,
        outputAttribution: (brain.output_attribution ?? {}) as Record<string, unknown>,
        runtimeTrace: (brain.runtime_trace ?? {}) as Record<string, unknown>,
        rawBrainOutput: brain as Record<string, unknown>,
      },
    };
  }

  private normalizeTier(input: string): TierLevel {
    if (input === "L1" || input === "L2" || input === "L3") {
      return input;
    }
    return "L2";
  }

  private extractDepartments(brain: BrainRouterOutput): DepartmentName[] {
    const picked = new Set<DepartmentName>();

    const experts = Array.isArray(brain.selected_experts) ? brain.selected_experts : [];
    for (const expert of experts) {
      const name = String(expert?.name ?? "").trim();
      const mapped = AGENT_TO_DEPARTMENT[name];
      if (mapped) {
        picked.add(mapped);
      }
    }

    if (picked.size === 0) {
      return ["research", "strategy", "legal", "market", "sales"];
    }

    return this.sortByDefaultOrder(Array.from(picked));
  }

  private extractDependencies(
    brain: BrainRouterOutput,
    departments: DepartmentName[],
  ): Partial<Record<DepartmentName, DepartmentName[]>> {
    const depMap: Partial<Record<DepartmentName, DepartmentName[]>> = {};
    for (const department of departments) {
      depMap[department] = [];
    }

    const edges = brain.collaboration_plan?.edges;
    if (Array.isArray(edges) && edges.length > 0) {
      for (const edge of edges) {
        const source = AGENT_TO_DEPARTMENT[String(edge?.from ?? "").trim()];
        const target = AGENT_TO_DEPARTMENT[String(edge?.to ?? "").trim()];
        if (!source || !target) {
          continue;
        }
        if (!depMap[target]) {
          depMap[target] = [];
        }
        if (!depMap[target]?.includes(source)) {
          depMap[target]?.push(source);
        }
      }
    }

    for (const department of departments) {
      const defaults = DEFAULT_DEPS[department] ?? [];
      if (!depMap[department] || depMap[department]?.length === 0) {
        depMap[department] = defaults.filter((dep) => departments.includes(dep));
      }
    }

    return depMap;
  }

  private sortByDefaultOrder(departments: DepartmentName[]): DepartmentName[] {
    const order: DepartmentName[] = ["research", "strategy", "legal", "market", "sales"];
    return departments.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
}
