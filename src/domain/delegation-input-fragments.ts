import { z } from "zod";

/**
 * Shared Zod fragment for delegation-context fields present on child workflow
 * inputs that are set by the kernel or orchestrator (never by the operator).
 *
 * All fields use `.min(1)` so an empty string set accidentally by a caller is
 * caught at schema-parse time instead of silently propagating. The field is
 * still optional from the operator perspective (omitted = standalone run).
 *
 * Usage — spread into child workflow schemas:
 *
 *   export const ChildInputSchema = z.object({
 *     // workflow-specific fields...
 *     ...PARENT_SUBJECT_FRAGMENT,
 *   });
 */

/** `parentSubject` — operator-facing subject label forwarded from the parent. */
export const PARENT_SUBJECT_FRAGMENT = {
  parentSubject: z.string().min(1).optional(),
} as const;

/** `parentRunId` — kernel-assigned parent run id for delegated children. */
export const PARENT_RUN_ID_FRAGMENT = {
  parentRunId: z.string().min(1).optional(),
} as const;

/**
 * `taskGroupId` — used by crm-doc-download and similar workflows to correlate
 * a fan-out group of delegated children under a shared logical group key.
 */
export const TASK_GROUP_ID_FRAGMENT = {
  taskGroupId: z.string().min(1).optional(),
} as const;

/** Full delegation context — combine when a workflow uses all three fields. */
export const DELEGATION_CONTEXT_FRAGMENT = {
  ...PARENT_SUBJECT_FRAGMENT,
  ...PARENT_RUN_ID_FRAGMENT,
  ...TASK_GROUP_ID_FRAGMENT,
} as const;
