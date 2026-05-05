export type TaskRole = "root" | "delegator" | "child" | "utility" | "approval";
export type QueuePlacement = "main" | "subqueue";

export interface TaskDisplayInput {
  workflow: string;
  subject: string;
  role: TaskRole;
  originWorkflow?: string;
  parentSubject?: string;
  parentRunId?: string;
  taskGroupId?: string;
}

export interface TaskDisplay extends TaskDisplayInput {
  queuePlacement: QueuePlacement;
}

export function buildTaskDisplay(input: TaskDisplayInput): TaskDisplay {
  return {
    ...input,
    queuePlacement: input.role === "child" || input.role === "approval" ? "subqueue" : "main",
  };
}
