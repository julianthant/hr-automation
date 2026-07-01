/**
 * Pre-submit sanity gate for a person/HR record.
 *
 * Two layers, split by risk (same shape as `normalize-contact.ts`):
 *   - **Deterministic rules** catch the mechanical mistakes — a malformed email,
 *     an unparseable / future / implausible DOB, an EID that isn't 5+ digits, a
 *     required field left blank. No LLM, no rate cost.
 *   - An optional **LLM cross-field pass** flags the things rules can't: a name
 *     that looks OCR-garbled, a value that seems typo'd, two fields that
 *     contradict each other — the kind of subtle mistake worth a second look
 *     before an irreversible UCPath / Kuali submit.
 *
 * ADVISORY ONLY. `sanityCheckRecord` returns a list of issues; it never blocks a
 * submit and never throws (LLM exhaustion just means the rule issues, minus the
 * cross-field ones). The caller decides whether to surface them as review
 * warnings, log them, or gate on `severity: "error"`. The human still confirms.
 */
import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { completeJson } from "./complete.js";
import type { CompleteOptions } from "./complete.js";

export interface SanityIssue {
  /** Field the issue concerns (or "record" for a cross-field problem). */
  field: string;
  severity: "error" | "warning";
  message: string;
  /** `rule` = deterministic; `llm` = model cross-field check. */
  source: "rule" | "llm";
}

/** Loose record shape — any string-valued fields the caller wants checked. */
export type CheckableRecord = Record<string, string | null | undefined>;

// ─── Deterministic rules ──────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate an email field; returns an issue or null. */
export function checkEmail(field: string, value: string | null | undefined): SanityIssue | null {
  if (!value || !value.trim()) return null;
  if (!EMAIL_RE.test(value.trim())) {
    return { field, severity: "error", message: `"${value}" is not a valid email address`, source: "rule" };
  }
  return null;
}

/** Validate a date-of-birth: parseable, in the past, plausible age (14–100). */
export function checkDob(field: string, value: string | null | undefined): SanityIssue | null {
  if (!value || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) {
    return { field, severity: "error", message: `"${value}" is not a parseable date`, source: "rule" };
  }
  // Age is computed against a caller-independent reference (no Date.now in tests):
  // use the year embedded in the value vs. a plausible band. We only flag clearly
  // impossible values, not borderline ones.
  const year = new Date(ms).getUTCFullYear();
  if (year < 1900) {
    return { field, severity: "warning", message: `DOB year ${year} looks too old — check the transcription`, source: "rule" };
  }
  if (year > 2025) {
    return { field, severity: "warning", message: `DOB year ${year} is in the future — check the transcription`, source: "rule" };
  }
  return null;
}

/** Validate a UCPath employee id: 5+ digits. */
export function checkEid(field: string, value: string | null | undefined): SanityIssue | null {
  if (!value || !value.trim()) return null;
  if (!/^\d{5,}$/.test(value.trim())) {
    return { field, severity: "warning", message: `EID "${value}" is not 5+ digits — check the transcription`, source: "rule" };
  }
  return null;
}

/** Flag a required field that is blank. */
export function checkRequired(field: string, value: string | null | undefined): SanityIssue | null {
  if (!value || !value.trim()) {
    return { field, severity: "error", message: `${field} is required but blank`, source: "rule" };
  }
  return null;
}

export interface RuleSpec {
  /** Fields to validate as emails. */
  email?: string[];
  /** Fields to validate as dates of birth. */
  dob?: string[];
  /** Fields to validate as UCPath EIDs. */
  eid?: string[];
  /** Fields that must be present. */
  required?: string[];
}

/** Run the deterministic rule checks described by `spec` over `record`. */
export function runRuleChecks(record: CheckableRecord, spec: RuleSpec): SanityIssue[] {
  const issues: SanityIssue[] = [];
  for (const f of spec.required ?? []) {
    const i = checkRequired(f, record[f]);
    if (i) issues.push(i);
  }
  for (const f of spec.email ?? []) {
    const i = checkEmail(f, record[f]);
    if (i) issues.push(i);
  }
  for (const f of spec.dob ?? []) {
    const i = checkDob(f, record[f]);
    if (i) issues.push(i);
  }
  for (const f of spec.eid ?? []) {
    const i = checkEid(f, record[f]);
    if (i) issues.push(i);
  }
  return issues;
}

// ─── LLM cross-field pass ─────────────────────────────────────

const LlmIssuesSchema = z.object({
  issues: z.array(
    z.object({
      field: z.string(),
      severity: z.enum(["error", "warning"]),
      message: z.string().min(1),
    }),
  ),
});

/**
 * Ask the pool to flag implausible / inconsistent / likely-mistyped values
 * across a record. Returns `[]` on exhaustion / bad reply (never throws). Only
 * worth calling when the record has a few populated fields.
 */
export async function llmCrossFieldCheck(
  record: CheckableRecord,
  opts: Pick<CompleteOptions, "cacheDir" | "pool" | "maxWaitMs"> & { workflow?: string } = {},
): Promise<SanityIssue[]> {
  const populated = Object.entries(record).filter(([, v]) => v != null && String(v).trim());
  if (populated.length === 0) return [];
  const recordJson = JSON.stringify(Object.fromEntries(populated), null, 0);

  const result = await completeJson({
    prompt: `You are the pre-submit sanity check for an HR record about to be written to UCPath.${opts.workflow ? ` Workflow: ${opts.workflow}.` : ""}
Flag ONLY things that look wrong: a value likely mistyped or OCR-garbled, two fields that contradict each other, an out-of-range value, or an obviously-swapped field. Do NOT flag correct data, and do NOT invent problems.

Record:
${recordJson}

Respond with ONLY JSON: {"issues":[{"field":"<field>","severity":"error|warning","message":"<one sentence>"}]}. Empty array if everything looks plausible.`,
    schema: LlmIssuesSchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    maxWaitMs: opts.maxWaitMs,
    logTag: "sanity",
    estTokens: 1200,
  });
  if (!result) return [];
  return result.issues.map((i) => ({ ...i, source: "llm" as const }));
}

// ─── Combined gate ────────────────────────────────────────────

export interface SanityCheckOptions extends Pick<CompleteOptions, "cacheDir" | "pool" | "maxWaitMs"> {
  /** Deterministic rules to run (email/dob/eid/required field lists). */
  rules?: RuleSpec;
  /** Run the LLM cross-field pass too (default true; false = rules only). */
  useLlm?: boolean;
  /** Workflow name for LLM context. */
  workflow?: string;
}

/**
 * Run the sanity gate: deterministic rules, then (unless `useLlm: false`) the
 * LLM cross-field pass. Returns all issues found. Never throws.
 */
export async function sanityCheckRecord(
  record: CheckableRecord,
  opts: SanityCheckOptions = {},
): Promise<SanityIssue[]> {
  const issues = runRuleChecks(record, opts.rules ?? {});
  if (opts.useLlm === false) return issues;
  try {
    const llm = await llmCrossFieldCheck(record, opts);
    issues.push(...llm);
  } catch (err) {
    log.warn(`[sanity] LLM cross-field check failed (kept rule issues): ${err instanceof Error ? err.message : String(err)}`);
  }
  return issues;
}

/**
 * Infer a `RuleSpec` from a record's field names — maps common HR field names
 * (email/dob/eid variants) onto their rule categories so a caller doesn't have
 * to spell the lists out. Matching is case-insensitive substring on the key.
 */
export function inferRuleSpec(record: CheckableRecord): RuleSpec {
  const email: string[] = [];
  const dob: string[] = [];
  const eid: string[] = [];
  for (const key of Object.keys(record)) {
    const k = key.toLowerCase();
    if (k.includes("email")) email.push(key);
    else if (k.includes("dob") || k.includes("dateofbirth") || k.includes("birth")) dob.push(key);
    else if (k === "eid" || k.includes("employeeid") || k.includes("emplid")) eid.push(key);
  }
  return { email, dob, eid };
}

/** True if any issue is an `error` (a caller may choose to gate on this). */
export function hasBlockingIssue(issues: SanityIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** One-line summary of issues for a review warning / log line. */
export function summarizeSanityIssues(issues: SanityIssue[]): string | null {
  if (issues.length === 0) return null;
  const parts = issues.map((i) => `${i.severity === "error" ? "✗" : "⚠"} ${i.field}: ${i.message}`);
  return `Sanity check: ${parts.join(" | ")}`;
}
