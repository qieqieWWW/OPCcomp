import type { DepartmentName } from "../../department-agents/base-agent";
import type { TaskPlan } from "./types";

export class DependencyManager {
  getExecutionOrder(plan: TaskPlan): DepartmentName[][] {
    this.assertNoCycle(plan);

    const pending = new Set<DepartmentName>(plan.departments);
    const completed = new Set<DepartmentName>();
    const batches: DepartmentName[][] = [];

    while (pending.size > 0) {
      const ready: DepartmentName[] = [];

      for (const department of pending) {
        if (this.canExecute(department, completed, plan.dependencies)) {
          ready.push(department);
        }
      }

      if (ready.length === 0) {
        throw new Error("DependencyManager cannot make progress: unresolved dependencies");
      }

      batches.push(ready);
      for (const dep of ready) {
        pending.delete(dep);
        completed.add(dep);
      }
    }

    return batches;
  }

  canExecute(
    department: DepartmentName,
    completed: Set<DepartmentName>,
    dependencies: Partial<Record<DepartmentName, DepartmentName[]>>,
  ): boolean {
    const deps = dependencies[department] ?? [];
    return deps.every((dep) => completed.has(dep));
  }

  private assertNoCycle(plan: TaskPlan): void {
    const temp = new Set<DepartmentName>();
    const perm = new Set<DepartmentName>();

    const visit = (node: DepartmentName) => {
      if (perm.has(node)) {
        return;
      }
      if (temp.has(node)) {
        throw new Error(`Dependency cycle detected at department: ${node}`);
      }

      temp.add(node);
      const deps = plan.dependencies[node] ?? [];
      for (const dep of deps) {
        if (plan.departments.includes(dep)) {
          visit(dep);
        }
      }
      temp.delete(node);
      perm.add(node);
    };

    for (const department of plan.departments) {
      visit(department);
    }
  }
}
