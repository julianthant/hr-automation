import { z } from "zod";

import {
  MAX_PARALLEL_WORKERS,
  MIN_PARALLEL_WORKERS,
} from "../../../domain/run-options.js";
import { PARENT_RUN_ID_VALIDATION_HINT, parseOptionalParentRunId } from "./parent-run-id.js";
import { jsonResponse, readJsonRequest } from "./responses.js";

/**
 * Strict Zod request schemas for the dashboard's JSON mutation routes.
 *
 * Before this module, routes hand-coerced bodies with `String(body.x ?? "")` —
 * an object silently became `"[object Object]"`, a missing required field
 * became `""`, and an invalid enum silently defaulted. All three violate the
 * fail-loud rule: a malformed request must 400 with a precise message, never
 * limp forward with a plausible-but-wrong value.
 *
 * Conventions:
 * - Required ids/names: non-empty trimmed string, wrong type → 400.
 * - Optional strings accept `null`/`""` as "absent" (the UI sends both) but
 *   reject non-string values instead of stringifying them.
 * - Enums with a documented default apply the default only when the field is
 *   ABSENT; a present-but-unknown value is a 400, not a silent fallback.
 */

// ── Field schemas ─────────────────────────────────────────────────────────────

/** Required non-empty string (trimmed). Wrong type or blank → 400. */
export const requiredString = z
  .string({ error: (iss) => (iss.input === undefined ? "required" : "must be a string") })
  .trim()
  .min(1, "must be a non-empty string");

/** Optional string: `undefined`/`null`/`""` mean absent; non-strings 400. */
export const optionalString = z
  .string({ error: () => "must be a string" })
  .nullish()
  .transform((v) => (v ? v : undefined));

/** Tracker date partition, `YYYY-MM-DD`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const optionalDate = z
  .union(
    [z.string().regex(DATE_RE, "must be YYYY-MM-DD"), z.literal(""), z.null()],
    { error: () => "must be a YYYY-MM-DD string" },
  )
  .optional()
  .transform((v) => (v ? v : undefined));

export const requiredDate = z
  .string({ error: () => "must be a YYYY-MM-DD string" })
  .regex(DATE_RE, "must be YYYY-MM-DD");

/**
 * Optional {@link parseOptionalParentRunId}-validated parent run id. Mirrors
 * the pre-Zod contract exactly: absent (`undefined`/`null`) is fine, anything
 * present must pass the shared shape check.
 */
export const optionalParentRunId = z.unknown().optional().transform((value, ctx) => {
  if (value === undefined || value === null) return undefined;
  const parsed = parseOptionalParentRunId(value);
  if (!parsed) {
    ctx.addIssue({ code: "custom", message: PARENT_RUN_ID_VALIDATION_HINT });
    return z.NEVER;
  }
  return parsed;
});

/** Enum whose default applies only when ABSENT — present-but-unknown 400s. */
function enumWithDefault<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) {
  return z
    .enum(values)
    .nullish()
    .transform((v) => v ?? fallback);
}

export const bulkActionSource = enumWithDefault(["queue-panel", "operation-view"], "queue-panel");
export const bulkActionScope = enumWithDefault(["group", "visible-view"], "group");
export const rowCancelScope = enumWithDefault(["row", "tree"], "row");

export const optionalRowStatus = z
  .enum(["pending", "running"])
  .nullish()
  .transform((v) => v ?? undefined);

/** Strict spawn count: integer within the shared parallel-worker bounds. */
export const spawnCount = z
  .number({ error: () => "must be a number" })
  .int("must be an integer")
  .min(MIN_PARALLEL_WORKERS, `must be ≥ ${MIN_PARALLEL_WORKERS}`)
  .max(MAX_PARALLEL_WORKERS, `must be ≤ ${MAX_PARALLEL_WORKERS}`)
  .nullish()
  .transform((v) => v ?? 1);

// ── Route body schemas (ops.ts) ───────────────────────────────────────────────

/** OCR delegation/cancel context fields shared by the cancel routes. */
const ocrCancelContext = {
  ocrSessionId: optionalString,
  parentWorkflow: optionalString,
  parentItemId: optionalString,
  formType: optionalString,
  reason: optionalString,
} as const;

export const retryBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
  date: optionalDate,
  parentRunId: optionalParentRunId,
});

const bulkItem = z.object({
  id: requiredString,
  workflowId: optionalString,
  runId: optionalString,
  date: optionalDate,
});

export const retryBulkBody = z.object({
  workflow: requiredString,
  ids: z.array(requiredString).nullish().transform((v) => v ?? []),
  items: z.array(bulkItem).nullish().transform((v) => (v && v.length > 0 ? v : undefined)),
  date: optionalDate,
  parentRunId: optionalParentRunId,
  source: bulkActionSource,
  scope: bulkActionScope,
});

export const runWithDataBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
  date: optionalDate,
  parentRunId: optionalParentRunId,
  data: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}),
});

export const eidApproveBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
  eid: requiredString,
  date: optionalDate,
});

export const eidDismissBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
  date: optionalDate,
});

export const saveDataBody = z.object({
  workflow: requiredString,
  id: requiredString,
  date: optionalDate,
  data: z.record(z.string(), z.unknown()),
});

export const rowCancelBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
  status: optionalRowStatus,
  scope: rowCancelScope,
  treeExcludeRoots: z
    .boolean()
    .nullish()
    .transform((v) => (v === true ? true : undefined)),
  parentRunId: optionalParentRunId,
  ...ocrCancelContext,
});

export const cancelRunningBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: requiredString,
});

export const cancelActiveBulkBody = z.object({
  workflow: requiredString,
  items: z
    .array(
      z.object({
        id: requiredString,
        status: z.enum(["pending", "running"]),
        runId: optionalString,
      }),
    )
    .min(1, "must be a non-empty array of { id, status }"),
});

export const browserKillBody = z.object({
  browserProcessId: optionalString,
  pid: z
    .number({ error: () => "must be a number" })
    .int("must be an integer")
    .positive("must be positive")
    .nullish()
    .transform((v) => v ?? undefined),
});

export const browserTargetBody = z.object({
  workflow: requiredString,
  instance: requiredString,
  systemId: requiredString,
});

export const autoRecoveryBody = browserTargetBody.extend({
  paused: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true"),
});

export const workerBody = z.object({ workerId: requiredString });

export const queueBumpBody = z.object({
  workflow: requiredString,
  id: requiredString,
  runId: optionalString,
});

export const daemonsSpawnBody = z.object({
  workflow: requiredString,
  count: spawnCount,
});

export const daemonsStopBody = z.object({
  workflow: optionalString,
  force: z
    .boolean()
    .nullish()
    .transform((v) => v === true),
});

export const deleteEntryBody = z.object({
  workflow: requiredString,
  id: requiredString,
  date: requiredDate,
  runId: optionalString,
});

export const deleteBulkBody = z
  .object({
    workflow: requiredString,
    date: requiredDate,
    ids: z.array(requiredString).nullish().transform((v) => v ?? []),
    items: z.array(bulkItem).nullish().transform((v) => v ?? []),
    source: bulkActionSource,
    scope: bulkActionScope,
  })
  .superRefine((val, ctx) => {
    if (val.ids.length === 0 && val.items.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "ids or items must be non-empty — provide at least one entry to delete",
      });
    }
  });

// ── Route body schemas (ocr.ts) ───────────────────────────────────────────────

/** OCR review-session addressing pair, present on every OCR mutation. */
const ocrSession = {
  sessionId: requiredString,
  runId: requiredString,
} as const;

export const ocrApproveBatchBody = z.object({
  ...ocrSession,
  // Approval creates REAL downstream work — a non-object records element is a
  // malformed request, not something to silently drop.
  records: z
    .array(z.record(z.string(), z.unknown()), { error: () => "must be an array of record objects" })
    .nullish()
    .transform((v) => v ?? []),
});

export const ocrDiscardBody = z.object({
  ...ocrSession,
  reason: optionalString,
  parentWorkflow: optionalString,
  parentRunId: optionalString,
  parentItemId: optionalString,
  formType: optionalString,
});

export const ocrForceResearchBody = z.object({
  ...ocrSession,
  recordIndices: z
    .array(z.number({ error: () => "must be a number" }).int().min(0))
    .nullish()
    .transform((v) => v ?? []),
});

export const ocrVerifyRelookupBody = z.object({
  ...ocrSession,
  recordIndex: z.number({ error: () => "must be a number" }).int().min(0),
  lookup: enumWithDefault(["person", "i9"], "person"),
});

export const ocrRetryPageBody = z.object({
  ...ocrSession,
  pageNum: z.number({ error: () => "must be a number" }).int().min(1),
});

export const ocrSessionBody = z.object(ocrSession);

// ── Route body schemas (capture.ts) ───────────────────────────────────────────

const photoIndex = z.number({ error: () => "must be a number" }).int("must be an integer").min(0);

export const captureStartBody = z.object({
  workflow: requiredString,
  contextHint: optionalString,
});

export const captureTokenBody = z.object({ token: requiredString });

export const captureDeletePhotoBody = z.object({
  token: requiredString,
  index: photoIndex,
});

export const captureDiscardBody = z.object({
  sessionId: requiredString,
  reason: optionalString,
});

export const captureReorderBody = z.object({
  token: requiredString,
  fromIndex: photoIndex,
  toIndex: photoIndex,
});

export const captureValidateBody = z.object({ sessionId: requiredString });

// ── Route body schemas (oath-upload.ts) ───────────────────────────────────────

export const oathUploadCancelBody = z.object({
  sessionId: requiredString,
  runId: optionalString,
  reason: optionalString,
});

// ── postJson adapter ──────────────────────────────────────────────────────────

type ParseFailure = { ok: false; error: string; status?: number };

/** `path: message` pairs, joined — precise enough to fix the request from. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Adapt a Zod schema to {@link postJson}'s `parse` slot. Schema failures
 * surface as a 400 with every offending field named.
 */
export function zodParse<S extends z.ZodType>(
  schema: S,
): (body: Record<string, unknown>) => z.output<S> | ParseFailure {
  return (body) => {
    const result = schema.safeParse(body);
    if (!result.success) return { ok: false, error: formatZodError(result.error) };
    return result.data;
  };
}

/**
 * Read + validate a JSON body for routes whose handlers own their own
 * `{ body, status }` response shape (the OCR routes). Returns a ready-made
 * 400 {@link Response} on malformed JSON or schema failure.
 */
export async function readValidatedJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes?: number,
): Promise<{ ok: true; body: z.output<S> } | { ok: false; response: Response }> {
  const parsed = await readJsonRequest(request, maxBytes);
  if (!parsed.ok) {
    return { ok: false, response: jsonResponse({ ok: false, error: parsed.error }, 400) };
  }
  const result = schema.safeParse(parsed.body);
  if (!result.success) {
    return { ok: false, response: jsonResponse({ ok: false, error: formatZodError(result.error) }, 400) };
  }
  return { ok: true, body: result.data };
}
