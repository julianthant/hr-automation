/**
 * Run options — operator-chosen execution metadata for a dashboard run.
 *
 * Today this carries one field: `parallelWorkers`, the operator's choice of how
 * many browser automation **daemons** to target for the downstream work a
 * PDF/OCR run fans out to (oath signers, emergency-contact rows, lookups). It is
 * *execution* metadata, not business data — it never reaches a workflow's Zod
 * input as a domain field; it rides as `runOptions` and is mapped to
 * {@link DaemonFlags} at the enqueue boundary.
 *
 * **Auto vs. a target count.** Absent / `"auto"` / empty means *Auto*: reuse
 * existing alive daemons, spawn one only if none are alive — exactly the
 * no-flags behavior of `ensureDaemonsAndEnqueue`. An explicit `N` is a
 * **target**: `{ parallel: N }` ensures at least N daemons are alive (spawns
 * only the deficit; never kills extras). It is NOT an exact per-run claim cap —
 * that would need task-group claim limits in the control plane and is out of
 * scope here.
 *
 * **Fail loud, don't auto-correct.** An explicit-but-invalid value (`0`,
 * negative, non-integer, above {@link MAX_PARALLEL_WORKERS}, non-numeric) is a
 * thrown error so HTTP routes reject it with a 4xx — we never silently clamp a
 * bad request to a "nearest" worker count. Only the explicit "no preference"
 * sentinels (absent / `"auto"` / `""`) resolve to Auto.
 */
import type { DaemonFlags } from "../core/daemon/types.js";

export interface RunOptions {
  /**
   * Target alive-daemon count for the run's downstream fan-out. Absent means
   * Auto. When present it is always a validated integer in
   * [{@link MIN_PARALLEL_WORKERS}, {@link MAX_PARALLEL_WORKERS}].
   */
  parallelWorkers?: number;
}

export const MIN_PARALLEL_WORKERS = 1;
export const MAX_PARALLEL_WORKERS = 8;

/** Case-insensitive sentinels that mean "Auto" (no explicit worker target). */
const AUTO_SENTINELS = new Set(["", "auto"]);

/**
 * Parse a raw `parallelWorkers` value (from a JSON body, multipart field, or
 * tracker `data`) into a validated worker count.
 *
 *   - `undefined` / `null` / `""` / `"auto"` (case-insensitive, trimmed)
 *     → `undefined` (Auto — an explicit, valid "no preference" choice).
 *   - A number or numeric string that is an integer in
 *     [{@link MIN_PARALLEL_WORKERS}, {@link MAX_PARALLEL_WORKERS}] → that number.
 *   - Anything else (0, negative, non-integer, out of range, non-numeric)
 *     → **throws**. The caller (HTTP route) maps the throw to a 4xx; we do not
 *     auto-correct an explicit bad value.
 */
export function parseParallelWorkers(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (AUTO_SENTINELS.has(trimmed.toLowerCase())) return undefined;
    // Reject anything that isn't a plain non-negative integer string up front,
    // so "4.5", "0x4", "1e2", " 4 workers" don't slip through Number()'s
    // permissive coercion.
    if (!/^\d+$/.test(trimmed)) {
      throw invalidWorkers(value);
    }
    return assertInRange(Number(trimmed), value);
  }

  if (typeof value === "number") {
    return assertInRange(value, value);
  }

  throw invalidWorkers(value);
}

function assertInRange(n: number, raw: unknown): number {
  if (!Number.isInteger(n) || n < MIN_PARALLEL_WORKERS || n > MAX_PARALLEL_WORKERS) {
    throw invalidWorkers(raw);
  }
  return n;
}

function invalidWorkers(raw: unknown): Error {
  return new Error(
    `parallelWorkers: ${JSON.stringify(raw)} is not a valid worker count — ` +
      `expected an integer in [${MIN_PARALLEL_WORKERS}, ${MAX_PARALLEL_WORKERS}] or "auto".`,
  );
}

/**
 * Normalize a loosely-typed `{ parallelWorkers }` carrier (HTTP body / multipart
 * fields) into a {@link RunOptions}. Auto resolves to `{}` (no `parallelWorkers`
 * key) so downstream `runOptionsToDaemonFlags` short-circuits to no flags.
 * Invalid explicit values throw via {@link parseParallelWorkers}.
 */
export function normalizeRunOptions(
  input: { parallelWorkers?: unknown } | undefined,
): RunOptions {
  const parsed = parseParallelWorkers(input?.parallelWorkers);
  return parsed === undefined ? {} : { parallelWorkers: parsed };
}

/**
 * Map run options to the daemon spawn flags consumed by
 * `ensureDaemonsAndEnqueue`. Auto and an explicit `1` both yield `{}` —
 * default no-flags behavior already reuses-or-spawns-one, so `{ parallel: 1 }`
 * would be a redundant flag that only noise up the daemon logs. Only `N > 1`
 * produces `{ parallel: N }`.
 */
export function runOptionsToDaemonFlags(options: RunOptions | undefined): DaemonFlags {
  const n = options?.parallelWorkers;
  if (n !== undefined && n > MIN_PARALLEL_WORKERS) {
    return { parallel: n };
  }
  return {};
}

/**
 * Serialize run options for stamping onto a tracker row's `data` (string-valued,
 * matching the HTTP enqueue serializer). Emits `{ parallelWorkers: "<n>" }` for
 * any explicit count (including `1`, to faithfully preserve the operator's
 * choice), `{}` for Auto. Read back later with {@link parseParallelWorkers}
 * (it accepts the numeric string), e.g. in the OCR approve fan-out.
 */
export function serializeRunOptionsForData(
  options: RunOptions | undefined,
): Record<string, string> {
  const n = options?.parallelWorkers;
  return n === undefined ? {} : { parallelWorkers: String(n) };
}
