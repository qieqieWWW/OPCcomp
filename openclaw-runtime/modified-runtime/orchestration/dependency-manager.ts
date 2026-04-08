import type { DepartmentName } from "../../department-agents/base-agent";
import type { TaskPlan } from "./types";

// 标准执行顺序：用于 cycle 断环时的兜底排序
const DEPARTMENT_ORDER: DepartmentName[] = ["research", "strategy", "legal", "market", "sales"];

export class DependencyManager {
  getExecutionOrder(plan: TaskPlan): DepartmentName[][] {
    // 先检测并自动修复 cycle，避免直接 throw 导致整个任务失败
    const safeDeps = this.buildSafeDependencies(plan);
    const safePlan: TaskPlan = { ...plan, dependencies: safeDeps };

    const pending = new Set<DepartmentName>(safePlan.departments);
    const completed = new Set<DepartmentName>();
    const batches: DepartmentName[][] = [];

    while (pending.size > 0) {
      const ready: DepartmentName[] = [];

      for (const department of pending) {
        if (this.canExecute(department, completed, safePlan.dependencies)) {
          ready.push(department);
        }
      }

      if (ready.length === 0) {
        // 兜底：直接按标准顺序取第一个 pending 部门，强制推进
        console.warn(
          `[DependencyManager] 依赖关系无法推进（可能存在隐性 cycle），强制按标准顺序取第一个 pending 部门。`,
          { pending: Array.from(pending), completed: Array.from(completed) },
        );
        const fallbackDept = DEPARTMENT_ORDER.find((d) => pending.has(d)) ?? Array.from(pending)[0];
        if (fallbackDept) {
          ready.push(fallbackDept);
        } else {
          break;
        }
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

  /**
   * 检测依赖图中是否含有环，若有则自动降级：
   * 移除形成 cycle 的边，回退到按标准顺序的串行依赖。
   * 不抛出异常，保证任务始终可执行。
   */
  buildSafeDependencies(
    plan: TaskPlan,
  ): Partial<Record<DepartmentName, DepartmentName[]>> {
    const hasCycle = this.detectCycle(plan.departments, plan.dependencies);
    if (!hasCycle) {
      return plan.dependencies;
    }

    console.warn(
      `[DependencyManager] 检测到依赖环，已自动降级为线性顺序依赖。departments=${plan.departments.join(",")}`,
    );

    // 降级：按标准顺序为每个 department 只依赖同组里排在它前面的那一个
    const sorted = DEPARTMENT_ORDER.filter((d) => plan.departments.includes(d));
    const safeDeps: Partial<Record<DepartmentName, DepartmentName[]>> = {};
    
    if (sorted.length > 0) {
      // 第一个部门没有依赖
      safeDeps[sorted[0] as DepartmentName] = [];
      // 从第二个部门开始，每个依赖前一个
      for (let i = 1; i < sorted.length; i++) {
        const dept = sorted[i] as DepartmentName;
        safeDeps[dept] = [sorted[i - 1] as DepartmentName];
      }
    }
    
    // 为不在标准顺序里的部门（理论上不存在）也兜底设为空
    for (const dept of plan.departments) {
      if (!(dept in safeDeps)) {
        safeDeps[dept] = [];
      }
    }
    return safeDeps;
  }

  private detectCycle(
    departments: DepartmentName[],
    dependencies: Partial<Record<DepartmentName, DepartmentName[]>>,
  ): boolean {
    const temp = new Set<DepartmentName>();
    const perm = new Set<DepartmentName>();

    const visit = (node: DepartmentName): boolean => {
      if (perm.has(node)) return false;
      if (temp.has(node)) return true; // cycle

      temp.add(node);
      const deps = dependencies[node] ?? [];
      for (const dep of deps) {
        if (departments.includes(dep) && visit(dep)) {
          return true;
        }
      }
      temp.delete(node);
      perm.add(node);
      return false;
    };

    for (const department of departments) {
      if (visit(department)) return true;
    }
    return false;
  }
}
