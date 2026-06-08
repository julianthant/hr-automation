import { randomUUID } from "node:crypto";

import { openDatabase, transaction, type Database } from "../../infra/sqlite/index.js";

import { openStateDb, runMigrations } from "../state/db.js";
import type {
  TaskAttemptStatus,
  TaskDependencyFailurePolicy,
  TaskDependencyKind,
  TaskDependencyStatus,
  TaskDependencySummary,
  TaskKind,
  TaskRow,
  TaskStatus,
} from "./types.js";

function taskSqlControlState(status: TaskStatus): string {
  if (status === "waiting_on_children" || status === "awaiting_child_results") return "waiting_dependencies";
  if (status === "pending") return "queued";
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "queued";
}

function taskStatusFromSqlControlState(controlState: string | null): TaskStatus {
  if (!controlState) return "queued";
  if (controlState === "waiting_dependencies") return "waiting_on_children";
  if (controlState === "claimed" || controlState === "cancel_requested" || controlState === "cancelling") {
    return "running";
  }
  if (controlState === "blocked") return "failed";
  if (
    controlState === "queued" ||
    controlState === "running" ||
    controlState === "done" ||
    controlState === "failed" ||
    controlState === "cancelled"
  ) {
    return controlState;
  }
  return "queued";
}

function attemptSqlControlState(status: TaskAttemptStatus): string {
  return status === "queued" ? "pending" : status;
}

export interface TaskStore {
  db: Database;
}

export interface TrackerIdentity {
  workflow: string;
  itemId: string;
  runId?: string;
}

export interface CreateParentTaskInput extends TrackerIdentity {
  taskKind: TaskKind;
  status: TaskStatus;
  data: Record<string, unknown>;
}

export interface CreateChildDependencyInput extends TrackerIdentity {
  taskKind: TaskKind;
  status: TaskStatus;
  dependencyKind: TaskDependencyKind;
  failurePolicy: TaskDependencyFailurePolicy;
  metadata: Record<string, unknown>;
}

interface UpsertTaskInput extends CreateParentTaskInput {
  parentTaskId?: string;
}

interface TaskDbRow {
  id: string;
  workflow: string;
  item_id: string;
  run_id: string | null;
  task_kind: TaskKind;
  control_state: string | null;
  parent_task_id: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface PendingTaskDependency {
  id: string;
  kind: TaskDependencyKind;
  status: TaskDependencyStatus;
  failurePolicy: TaskDependencyFailurePolicy;
  metadata: Record<string, unknown>;
  result: Record<string, unknown>;
  parent: TaskRow;
  child: TaskRow;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export function openTaskStore(trackerDir?: string): TaskStore {
  return { db: openStateDb(trackerDir) };
}

export function openTaskStoreForTests(dbPath: string): TaskStore {
  const db = openDatabase(dbPath);
  runMigrations(db);
  return { db };
}

export function createTaskDependencyBatch(
  store: TaskStore,
  input: {
    parent: CreateParentTaskInput;
    children: CreateChildDependencyInput[];
    now?: string;
  },
): {
  parentTaskId: string;
  children: Array<{ taskId: string; attemptId: string; itemId: string; runId: string }>;
  dependencies: Array<{ id: string; childTaskId: string }>;
} {
  const now = input.now ?? new Date().toISOString();
  return transaction(store.db, () => {
    const parentTaskId = upsertTask(store, input.parent, now);
    const children = input.children.map((child) => {
      const childTaskId = upsertTask(store, { ...child, parentTaskId, data: {} }, now);
      const attemptId = upsertAttempt(store, {
        taskId: childTaskId,
        attemptNo: 1,
        runId: child.runId ?? "",
        trackerWorkflow: child.workflow,
        trackerItemId: child.itemId,
        status: child.status === "queued" ? "queued" : "running",
        data: {},
        now,
      });
      const dependencyId = upsertDependency(store, {
        parentTaskId,
        childTaskId,
        kind: child.dependencyKind,
        status: "pending",
        failurePolicy: child.failurePolicy,
        metadata: child.metadata,
        now,
      });
      return {
        taskId: childTaskId,
        attemptId,
        dependencyId,
        itemId: child.itemId,
        runId: child.runId ?? "",
      };
    });
    return {
      parentTaskId,
      children,
      dependencies: children.map((child) => ({ id: child.dependencyId, childTaskId: child.taskId })),
    };
  });
}

export function createOcrEidLookupDependencyBatch(input: {
  trackerDir?: string;
  parent: { workflow: "ocr"; itemId: string; runId: string; formType: string };
  children: Array<{
    workflow: "person-lookup";
    itemId: string;
    runId: string;
    recordIndex: number;
    lookupKind: "name" | "verify" | "verify-only";
    formType: string;
  }>;
  now?: string;
}): ReturnType<typeof createTaskDependencyBatch> {
  return createTaskDependencyBatch(openTaskStore(input.trackerDir), {
    parent: {
      workflow: input.parent.workflow,
      itemId: input.parent.itemId,
      runId: input.parent.runId,
      taskKind: "ocr",
      status: "waiting_on_children",
      data: { formType: input.parent.formType },
    },
    children: input.children.map((child) => ({
      workflow: child.workflow,
      itemId: child.itemId,
      runId: child.runId,
      taskKind: "workflow_item",
      status: "queued",
      dependencyKind: "ocr-eid-lookup",
      failurePolicy: "record_unresolved",
      metadata: {
        recordIndex: child.recordIndex,
        lookupKind: child.lookupKind,
        formType: child.formType,
      },
    })),
    now: input.now,
  });
}

export function createOcrActiveCheckDependencyBatch(input: {
  trackerDir?: string;
  parent: { workflow: "ocr"; itemId: string; runId: string; formType: string };
  children: Array<{
    workflow: "active-check";
    itemId: string;
    runId: string;
    recordIndex: number;
    lookupKind: "verify" | "verify-only";
    formType: string;
  }>;
  now?: string;
}): ReturnType<typeof createTaskDependencyBatch> {
  return createTaskDependencyBatch(openTaskStore(input.trackerDir), {
    parent: {
      workflow: input.parent.workflow,
      itemId: input.parent.itemId,
      runId: input.parent.runId,
      taskKind: "ocr",
      status: "waiting_on_children",
      data: { formType: input.parent.formType },
    },
    children: input.children.map((child) => ({
      workflow: child.workflow,
      itemId: child.itemId,
      runId: child.runId,
      taskKind: "workflow_item",
      status: "queued",
      dependencyKind: "ocr-active-check",
      failurePolicy: "record_unresolved",
      metadata: {
        recordIndex: child.recordIndex,
        lookupKind: child.lookupKind,
        formType: child.formType,
      },
    })),
    now: input.now,
  });
}

export function getTaskByTrackerIdentity(store: TaskStore, identity: TrackerIdentity): TaskRow | null {
  const row = findTaskDbRow(store, identity);
  return row ? mapTaskRow(row) : null;
}

export function getDependencySummary(store: TaskStore, parentTaskId: string): TaskDependencySummary {
  const rows = store.db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM task_dependencies
    WHERE parent_task_id = @parentTaskId
    GROUP BY status
  `).all({ parentTaskId }) as Array<{ status: TaskDependencyStatus; n: number }>;
  const summary: TaskDependencySummary = {
    total: 0,
    pending: 0,
    satisfied: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    summary[row.status] = row.n;
    summary.total += row.n;
  }
  return summary;
}

export function markDependencyTerminal(
  store: TaskStore,
  input: {
    dependencyId: string;
    status: Exclude<TaskDependencyStatus, "pending">;
    result: Record<string, unknown>;
    now?: string;
  },
): void {
  const now = input.now ?? new Date().toISOString();
  store.db.prepare(`
    UPDATE task_dependencies
    SET status = @status,
        result_json = @resultJson,
        updated_at = @now,
        terminal_at = COALESCE(terminal_at, @now)
    WHERE id = @dependencyId
  `).run({
    dependencyId: input.dependencyId,
    status: input.status,
    resultJson: JSON.stringify(input.result),
    now,
  });
}

export function listPendingDependencies(
  store: TaskStore,
  opts: { limit?: number } = {},
): PendingTaskDependency[] {
  const rows = store.db.prepare(`
    SELECT
      d.id AS dependency_id,
      d.kind AS dependency_kind,
      d.status AS dependency_status,
      d.failure_policy,
      d.metadata_json,
      d.result_json,
      d.created_at AS dependency_created_at,
      d.updated_at AS dependency_updated_at,
      d.terminal_at AS dependency_terminal_at,
      p.id AS parent_id,
      p.workflow AS parent_workflow,
      p.item_id AS parent_item_id,
      p.run_id AS parent_run_id,
      p.task_kind AS parent_task_kind,
      p.control_state AS parent_control_state,
      p.parent_task_id AS parent_parent_task_id,
      p.data_json AS parent_data_json,
      p.created_at AS parent_created_at,
      p.updated_at AS parent_updated_at,
      p.terminal_at AS parent_terminal_at,
      c.id AS child_id,
      c.workflow AS child_workflow,
      c.item_id AS child_item_id,
      c.run_id AS child_run_id,
      c.task_kind AS child_task_kind,
      c.control_state AS child_control_state,
      c.parent_task_id AS child_parent_task_id,
      c.data_json AS child_data_json,
      c.created_at AS child_created_at,
      c.updated_at AS child_updated_at,
      c.terminal_at AS child_terminal_at
    FROM task_dependencies d
    JOIN tasks p ON p.id = d.parent_task_id
    JOIN tasks c ON c.id = d.child_task_id
    WHERE d.status = 'pending'
    ORDER BY d.updated_at ASC, d.id ASC
    LIMIT @limit
  `).all({ limit: opts.limit ?? 100 }) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.dependency_id),
    kind: row.dependency_kind as TaskDependencyKind,
    status: row.dependency_status as TaskDependencyStatus,
    failurePolicy: row.failure_policy as TaskDependencyFailurePolicy,
    metadata: parseJsonObject(row.metadata_json),
    result: parseJsonObject(row.result_json),
    parent: mapTaskRow(prefixedTaskRow(row, "parent")),
    child: mapTaskRow(prefixedTaskRow(row, "child")),
    createdAt: String(row.dependency_created_at),
    updatedAt: String(row.dependency_updated_at),
    ...(row.dependency_terminal_at ? { terminalAt: String(row.dependency_terminal_at) } : {}),
  }));
}

export function updateTaskStatus(
  store: TaskStore,
  input: { taskId: string; status: TaskStatus; now?: string },
): void {
  const now = input.now ?? new Date().toISOString();
  const controlState = taskSqlControlState(input.status);
  store.db.prepare(`
    UPDATE tasks
    SET control_state = @controlState,
        updated_at = @now,
        terminal_at = CASE
          WHEN @controlState IN ('done', 'failed', 'cancelled') THEN COALESCE(terminal_at, @now)
          ELSE terminal_at
        END
    WHERE id = @taskId
  `).run({ taskId: input.taskId, controlState, now });
}

export function updateAttemptStatus(
  store: TaskStore,
  input: { attemptId?: string; taskId?: string; runId?: string; status: TaskAttemptStatus; now?: string },
): void {
  const now = input.now ?? new Date().toISOString();
  const controlState = attemptSqlControlState(input.status);
  store.db.prepare(`
    UPDATE task_attempts
    SET control_state = @controlState,
        updated_at = @now,
        terminal_at = CASE
          WHEN @controlState IN ('done', 'failed', 'cancelled') THEN COALESCE(terminal_at, @now)
          ELSE terminal_at
        END
    WHERE (@attemptId IS NOT NULL AND id = @attemptId)
       OR (@attemptId IS NULL AND @taskId IS NOT NULL AND task_id = @taskId AND run_id = @runId)
  `).run({
    attemptId: input.attemptId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    controlState,
    now,
  });
}

export function allDependenciesTerminal(store: TaskStore, parentTaskId: string): boolean {
  const row = store.db.prepare(`
    SELECT COUNT(*) AS n
    FROM task_dependencies
    WHERE parent_task_id = @parentTaskId AND status = 'pending'
  `).get({ parentTaskId }) as { n: number };
  return row.n === 0;
}

export function getDependencySummaryByParentRunId(
  store: TaskStore,
  parentRunId: string,
): {
  parentRunId: string;
  summary: TaskDependencySummary;
  children: Array<{
    workflow: string;
    itemId: string;
    runId?: string;
    status: string;
    metadata: Record<string, unknown>;
    traceId?: string;
  }>;
} {
  const parent = store.db.prepare(`
    SELECT *
    FROM tasks
    WHERE run_id = @parentRunId
    ORDER BY updated_at DESC
    LIMIT 1
  `).get({ parentRunId }) as TaskDbRow | undefined;
  if (!parent) {
    return {
      parentRunId,
      summary: { total: 0, pending: 0, satisfied: 0, failed: 0, cancelled: 0 },
      children: [],
    };
  }

  const children = store.db.prepare(`
    SELECT
      c.workflow,
      c.item_id,
      c.run_id,
      c.control_state,
      d.metadata_json,
      (
        SELECT r.latest_data_json
        FROM runs r
        WHERE r.workflow = c.workflow
          AND r.item_id = c.item_id
          AND r.run_id = c.run_id
        ORDER BY r.latest_tracker_ts DESC
        LIMIT 1
      ) AS latest_data_json
    FROM task_dependencies d
    JOIN tasks c ON c.id = d.child_task_id
    WHERE d.parent_task_id = @parentTaskId
    ORDER BY d.created_at ASC, d.id ASC
  `).all({ parentTaskId: parent.id }) as Array<{
    workflow: string;
    item_id: string;
    run_id: string | null;
    control_state: string | null;
    metadata_json: string;
    latest_data_json: string | null;
  }>;

  return {
    parentRunId,
    summary: getDependencySummary(store, parent.id),
    children: children.map((child) => ({
      workflow: child.workflow,
      itemId: child.item_id,
      ...(child.run_id ? { runId: child.run_id } : {}),
      status: taskStatusFromSqlControlState(child.control_state),
      metadata: parseJsonObject(child.metadata_json),
      ...readTraceId(child.latest_data_json),
    })),
  };
}

function upsertTask(store: TaskStore, input: UpsertTaskInput, now: string): string {
  const existing = findTaskDbRow(store, input);
  const terminalAt = isTerminalTaskStatus(input.status) ? now : null;
  const controlState = taskSqlControlState(input.status);
  if (existing) {
    store.db.prepare(`
      UPDATE tasks
      SET control_state = @controlState,
          task_kind = @taskKind,
          parent_task_id = COALESCE(@parentTaskId, parent_task_id),
          data_json = @dataJson,
          updated_at = @now,
          terminal_at = CASE
            WHEN @terminalAt IS NOT NULL THEN COALESCE(terminal_at, @terminalAt)
            ELSE terminal_at
          END
      WHERE id = @id
    `).run({
      id: existing.id,
      taskKind: input.taskKind,
      controlState,
      parentTaskId: input.parentTaskId ?? null,
      dataJson: JSON.stringify(input.data),
      terminalAt,
      now,
    });
    return existing.id;
  }

  const id = randomUUID();
  store.db.prepare(`
    INSERT INTO tasks (
      id, workflow, item_id, run_id, task_kind, control_state, parent_task_id,
      data_json, created_at, updated_at, terminal_at
    ) VALUES (
      @id, @workflow, @itemId, @runId, @taskKind, @controlState, @parentTaskId,
      @dataJson, @now, @now, @terminalAt
    )
  `).run({
    id,
    workflow: input.workflow,
    itemId: input.itemId,
    runId: input.runId ?? null,
    taskKind: input.taskKind,
    controlState,
    parentTaskId: input.parentTaskId ?? null,
    dataJson: JSON.stringify(input.data),
    terminalAt,
    now,
  });
  return id;
}

function upsertAttempt(
  store: TaskStore,
  input: {
    taskId: string;
    attemptNo: number;
    runId: string;
    trackerWorkflow: string;
    trackerItemId: string;
    status: TaskAttemptStatus;
    data: Record<string, unknown>;
    now: string;
  },
): string {
  const existing = store.db.prepare(`
    SELECT id
    FROM task_attempts
    WHERE tracker_workflow = @trackerWorkflow
      AND tracker_item_id = @trackerItemId
      AND run_id = @runId
  `).get(input) as { id: string } | undefined;
  const terminalAt = isTerminalAttemptStatus(input.status) ? input.now : null;
  const controlState = attemptSqlControlState(input.status);
  if (existing) {
    store.db.prepare(`
      UPDATE task_attempts
      SET control_state = @controlState,
          data_json = @dataJson,
          updated_at = @now,
          terminal_at = CASE
            WHEN @terminalAt IS NOT NULL THEN COALESCE(terminal_at, @terminalAt)
            ELSE terminal_at
          END
      WHERE id = @id
    `).run({
      id: existing.id,
      controlState,
      dataJson: JSON.stringify(input.data),
      terminalAt,
      now: input.now,
    });
    return existing.id;
  }

  const id = randomUUID();
  store.db.prepare(`
    INSERT INTO task_attempts (
      id, task_id, attempt_no, run_id, control_state, tracker_workflow,
      tracker_item_id, started_at, terminal_at, data_json, created_at, updated_at
    ) VALUES (
      @id, @taskId, @attemptNo, @runId, @controlState, @trackerWorkflow,
      @trackerItemId, @startedAt, @terminalAt, @dataJson, @now, @now
    )
  `).run({
    id,
    taskId: input.taskId,
    attemptNo: input.attemptNo,
    runId: input.runId,
    controlState,
    trackerWorkflow: input.trackerWorkflow,
    trackerItemId: input.trackerItemId,
    startedAt: input.status === "running" ? input.now : null,
    terminalAt,
    dataJson: JSON.stringify(input.data),
    now: input.now,
  });
  return id;
}

function upsertDependency(
  store: TaskStore,
  input: {
    parentTaskId: string;
    childTaskId: string;
    kind: TaskDependencyKind;
    status: TaskDependencyStatus;
    failurePolicy: TaskDependencyFailurePolicy;
    metadata: Record<string, unknown>;
    now: string;
  },
): string {
  const existing = store.db.prepare(`
    SELECT id
    FROM task_dependencies
    WHERE parent_task_id = @parentTaskId
      AND child_task_id = @childTaskId
      AND kind = @kind
  `).get(input) as { id: string } | undefined;
  if (existing) {
    store.db.prepare(`
      UPDATE task_dependencies
      SET status = @status,
          failure_policy = @failurePolicy,
          metadata_json = @metadataJson,
          updated_at = @now,
          terminal_at = CASE
            WHEN @status = 'pending' THEN NULL
            ELSE COALESCE(terminal_at, @now)
          END
      WHERE id = @id
    `).run({
      id: existing.id,
      status: input.status,
      failurePolicy: input.failurePolicy,
      metadataJson: JSON.stringify(input.metadata),
      now: input.now,
    });
    return existing.id;
  }

  const id = randomUUID();
  store.db.prepare(`
    INSERT INTO task_dependencies (
      id, parent_task_id, child_task_id, kind, status, failure_policy,
      metadata_json, result_json, created_at, updated_at, terminal_at
    ) VALUES (
      @id, @parentTaskId, @childTaskId, @kind, @status, @failurePolicy,
      @metadataJson, '{}', @now, @now, NULL
    )
  `).run({
    id,
    parentTaskId: input.parentTaskId,
    childTaskId: input.childTaskId,
    kind: input.kind,
    status: input.status,
    failurePolicy: input.failurePolicy,
    metadataJson: JSON.stringify(input.metadata),
    now: input.now,
  });
  return id;
}

function findTaskDbRow(store: TaskStore, identity: TrackerIdentity): TaskDbRow | null {
  if (identity.runId) {
    return (store.db.prepare(`
      SELECT *
      FROM tasks
      WHERE workflow = @workflow AND item_id = @itemId AND run_id = @runId
      LIMIT 1
    `).get(identity) as TaskDbRow | undefined) ?? null;
  }
  return (store.db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = @workflow AND item_id = @itemId AND run_id IS NULL
    LIMIT 1
  `).get(identity) as TaskDbRow | undefined) ?? null;
}

function mapTaskRow(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    workflow: row.workflow,
    itemId: row.item_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    taskKind: row.task_kind,
    status: taskStatusFromSqlControlState(row.control_state),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    data: parseJsonObject(row.data_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
  };
}

function prefixedTaskRow(row: Record<string, unknown>, prefix: "parent" | "child"): TaskDbRow {
  const csRaw = row[`${prefix}_control_state`];
  return {
    id: String(row[`${prefix}_id`]),
    workflow: String(row[`${prefix}_workflow`]),
    item_id: String(row[`${prefix}_item_id`]),
    run_id: row[`${prefix}_run_id`] ? String(row[`${prefix}_run_id`]) : null,
    task_kind: row[`${prefix}_task_kind`] as TaskKind,
    control_state: csRaw != null ? String(csRaw) : null,
    parent_task_id: row[`${prefix}_parent_task_id`] ? String(row[`${prefix}_parent_task_id`]) : null,
    data_json: row[`${prefix}_data_json`] ? String(row[`${prefix}_data_json`]) : "{}",
    created_at: String(row[`${prefix}_created_at`]),
    updated_at: String(row[`${prefix}_updated_at`]),
    terminal_at: row[`${prefix}_terminal_at`] ? String(row[`${prefix}_terminal_at`]) : null,
  };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readTraceId(raw: unknown): { traceId: string } | Record<string, never> {
  const data = parseJsonObject(raw);
  const traceId = data.__traceId;
  return typeof traceId === "string" && traceId.trim()
    ? { traceId }
    : {};
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function isTerminalAttemptStatus(status: TaskAttemptStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
