import type { DepartmentName } from "../../department-agents/base-agent";
import type { ExecutionEvent } from "../orchestration/types";

export class ExecutionMonitor {
  private readonly events: ExecutionEvent[] = [];

  taskStarted(taskId: string): void {
    this.events.push({ taskId, type: "task_started", timestamp: new Date() });
  }

  taskFinished(taskId: string): void {
    this.events.push({ taskId, type: "task_finished", timestamp: new Date() });
  }

  approvalRequired(taskId: string, detail?: string): void {
    const event: ExecutionEvent = {
      taskId,
      type: "approval_required",
      timestamp: new Date(),
    };
    if (detail !== undefined) {
      event.detail = detail;
    }
    this.events.push(event);
  }

  approvalGranted(taskId: string, detail?: string): void {
    const event: ExecutionEvent = {
      taskId,
      type: "approval_granted",
      timestamp: new Date(),
    };
    if (detail !== undefined) {
      event.detail = detail;
    }
    this.events.push(event);
  }

  approvalBlocked(taskId: string, detail: string): void {
    this.events.push({
      taskId,
      type: "approval_blocked",
      timestamp: new Date(),
      detail,
    });
  }

  departmentStarted(taskId: string, department: DepartmentName): void {
    this.events.push({
      taskId,
      department,
      type: "department_started",
      timestamp: new Date(),
    });
  }

  departmentSucceeded(taskId: string, department: DepartmentName): void {
    this.events.push({
      taskId,
      department,
      type: "department_succeeded",
      timestamp: new Date(),
    });
  }

  departmentFailed(taskId: string, department: DepartmentName, detail: string): void {
    this.events.push({
      taskId,
      department,
      type: "department_failed",
      timestamp: new Date(),
      detail,
    });
  }

  getTaskEvents(taskId: string): ExecutionEvent[] {
    return this.events.filter((item) => item.taskId === taskId);
  }

  getAllEvents(): ExecutionEvent[] {
    return [...this.events];
  }

  buildTaskTrace(taskId: string): ExecutionEvent[] {
    return this.getTaskEvents(taskId).map((event) => {
      const traceEvent: ExecutionEvent = {
        taskId: event.taskId,
        type: event.type,
        timestamp: event.timestamp,
      };

      if (event.department !== undefined) {
        traceEvent.department = event.department;
      }

      if (event.detail !== undefined) {
        traceEvent.detail = event.detail;
      }

      return traceEvent;
    });
  }
}
