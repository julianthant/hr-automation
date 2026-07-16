import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: root CLAUDE.md "Fail loud — no unverified silent fallbacks" calls
 * out `?? "SDCMP"` / `?? "queued"` on corrupted input as bugs, not
 * resilience — a nullish-coalescing default that substitutes a
 * plausible-looking business VALUE for missing data-shaped input hides the
 * absence instead of surfacing it.
 *
 * This flags `?? "<string literal>"` / `?? 0` / `?? true` where the left
 * side is a data-shaped property access (`data.foo`, `row.bar`, `input.baz`,
 * `item.x`, `entry.x`, `record.x`, `payload.x`, `fields.x`, `opts.x`,
 * `args.x`) in the layers that touch real HR/tracker data: src/core,
 * src/control, src/tracker, src/workflows, src/systems, src/services.
 * src/dashboard is deliberately excluded — plain display/label fallbacks
 * there are legitimate presentation defaults, not HR transaction data.
 *
 * Every survivor below was read in context: the literal is either an empty
 * string / generic display sentinel ("", "unknown", "N/A", "<none>", "?")
 * that is validated or branched-on immediately after (never trusted as a
 * real value), an app-level config default (".tracker", a boolean function
 * option), or a schema-defined enum default — never a plausible-but-wrong
 * substitute for real employee/transaction data. This is a RATCHET
 * (per-file count): new nullish-literal data fallbacks fail immediately and
 * need the same read-in-context review, not a silent allowlist add.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["src/core", "src/control", "src/tracker", "src/workflows", "src/systems", "src/services"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

// Data-shaped LHS identifiers, per the task heuristic: property access like
// data.foo / row.bar / input.baz. `?? "<string>"` / `?? 0` / `?? true` only
// (not `?? null/undefined/[]/{}` — those don't fabricate a plausible value,
// and not `?? otherVariable` — that's a different, already-covered pattern).
const NULLISH_LITERAL_RE =
  /\b(data|row|input|item|entry|record|payload|fields|opts|args)\.[A-Za-z0-9_.]+\s*\?\?\s*("(?:[^"\\]|\\.)*"|0|true)(?!\s*[?:.\w])/g;

/** file (relative to repo root) -> { count, reason } */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/core/daemon/in-flight-shutdown.ts": {
    count: 1,
    reason: "`args.settleDependency ?? true` is a declared function-parameter default (caller didn't specify -> default to true), not a failure-recovery fallback on corrupted data.",
  },
  "src/control/ocr/discard.ts": {
    count: 5,
    reason: "`input.reason ?? \"...discarded...\"` fills a human-readable audit message when the operator didn't type one; `opts.trackerDir ?? \".tracker\"` is the standard app-level tracker-dir default used throughout the codebase, not employee data.",
  },
  "src/control/ops/delete.ts": {
    count: 1,
    reason: "`item.id ?? \"\"` feeds only an error message ('id is required') for an item that has no id — empty string there is cosmetic, not decision data.",
  },
  "src/tracker/dashboard/hono/routes/capture.ts": {
    count: 1,
    reason: "`multipart.parsed.fields.token ?? \"\"` — an absent upload token fails the subsequent token-format check safely (empty string never matches an expected token).",
  },
  "src/tracker/dashboard/hono/routes/daemon-stop-instance.ts": {
    count: 2,
    reason: "`input.workflow ?? \"\"` / `input.instance ?? \"\"` — empty string fails downstream lookups safely (no such workflow/instance found) rather than being treated as a real name.",
  },
  "src/tracker/dashboard/hono/routes/entries-payload.ts": {
    count: 1,
    reason: "`row.n ?? 0` — a SQL aggregate count from a LEFT JOIN with no matching rows; 0 is the semantically correct count, not a fabricated value.",
  },
  "src/tracker/dashboard/hono/routes/ops.ts": {
    count: 1,
    reason: "`item.id ?? \"\"` stringifies an id for a response payload; an absent id becomes an empty string that fails any subsequent id-format check.",
  },
  "src/tracker/dashboard/oath-upload/http.ts": {
    count: 4,
    reason: "`input.hash ?? \"\"` / `input.pdfHash ?? \"\"` are immediately regex-validated as a 64-char hex hash and rejected (400) when empty; `input.mode ?? \"upload-only\"` is a declared API default; `opts.trackerDir ?? \".tracker\"` is the standard app-level default.",
  },
  "src/tracker/dashboard/selector-warnings.ts": {
    count: 4,
    reason: "`entry.workflow/level/message/ts ?? \"\"` — display fields for a selector-warning log entry; an absent field renders as blank, not a fabricated value.",
  },
  "src/tracker/dashboard/server.ts": {
    count: 1,
    reason: "`opts.workflow ?? \"onboarding\"` is a declared CLI/server option default, not a failure-recovery fallback.",
  },
  "src/tracker/dashboard/session-state.ts": {
    count: 1,
    reason: "`e.data.level ?? \"step\"` — a log-event's own default severity level when unspecified; a display/classification default, not fabricated transaction data.",
  },
  "src/tracker/delegation/watch-child-runs.ts": {
    count: 3,
    reason: "`row.control_state ?? \"queued\"` is the row's own documented initial-state default (a brand-new row has no control_state yet); `opts.trackerDir ?? \".tracker\"` is the standard default; `entry.runId ?? \"\"` feeds a composite cache key, not a decision.",
  },
  "src/tracker/exports/export-excel.ts": {
    count: 2,
    reason: "`entry.step ?? \"\"` / `entry.error ?? \"\"` — spreadsheet export display columns for an entry with no step/error; blank cells, not fabricated values.",
  },
  "src/tracker/files/register-download.ts": {
    count: 1,
    reason: "`input.trackerDir ?? \".tracker\"` is the standard app-level tracker-dir default.",
  },
  "src/tracker/find-latest-entry.ts": {
    count: 1,
    reason: "`opts.trackerDir ?? \".tracker\"` is the standard app-level tracker-dir default.",
  },
  "src/tracker/jsonl-io.ts": {
    count: 2,
    reason: "`entry.message ?? \"\"` coerces a log message for scrubbing; `entry.runId ?? \"\"` feeds a composite dedup key — both display/keying, not decision data.",
  },
  "src/tracker/queue-surfaces.ts": {
    count: 1,
    reason: "`entry.runId ?? \"\"` feeds a composite queue-surface key for a root (non-delegated) row that has no runId scope segment.",
  },
  "src/tracker/state/ocr-approval-store.ts": {
    count: 2,
    reason: "`row.error ?? \"approval failed\"` supplies a generic message only when an ALREADY-failed approval row stored no explicit error (a valid state, not a masked check); `(row.lease_expires_at_ms ?? 0) <= nowMs` treats a null lease as expired/reclaimable — the safe direction, mirrored by the atomic `COALESCE(lease_expires_at_ms, 0)` UPDATE guard that is the authoritative gate. Both read the authoritative SQLite ocr_approvals row, never employee/transaction data.",
  },
  "src/tracker/tasks/http.ts": {
    count: 1,
    reason: "`input.parentRunId ?? \"\"` then `.trim()` — an absent parent scope becomes empty string, which the caller's subsequent lookup treats as 'no parent', a valid state.",
  },
  "src/tracker/tasks/ocr-continuation.ts": {
    count: 2,
    reason: "`args.childRun.runId ?? \"\"` feeds a display/log field for a continuation record, not a decision.",
  },
  "src/tracker/tasks/store.ts": {
    count: 1,
    reason: "`input.reason ?? \"Cancelled by user\"` is the declared default audit reason when the operator/caller doesn't supply one — a UI-facing default string, not fabricated transaction data.",
  },
  "src/tracker/tracked-workflow.ts": {
    count: 1,
    reason: "`opts.archetype ?? \"single\"` is a declared function-option default (most workflows are archetype 'single'), not a failure-recovery fallback.",
  },
  "src/workflows/oath-signature/workflow.ts": {
    count: 2,
    reason: "`input.name ?? \"\"` seeds a display/context field (employeeName) on the oath context; the identity key (emplId) is handled separately via an explicit `.trim() || input.emplId` chain with no literal fallback.",
  },
  "src/workflows/oath-upload/duplicate-check.ts": {
    count: 2,
    reason: "`opts.trackerDir ?? \".tracker\"` is the standard app-level default; `row.latest_step ?? \"\"` is a display field in a prior-run summary, not the authoritative duplicate gate (the sha256-registered-file check owns that).",
  },
  "src/workflows/ocr/orchestrator.ts": {
    count: 1,
    reason: "`input.sessionId ?? \"\"` feeds a log-correlation id field, not decision logic.",
  },
  "src/workflows/onbase/handler.ts": {
    count: 1,
    reason: "`input.employeeName ?? \"\"` seeds a display field on the tracker row; the operational identifier is `ucpathId`, handled separately and required by the schema.",
  },
  "src/workflows/onbase/workflow.ts": {
    count: 1,
    reason: "Same as onbase/handler.ts: `input.employeeName ?? \"\"` is a display-only field; `ucpathId` is the real identifier.",
  },
  "src/workflows/onboarding/enter.ts": {
    count: 2,
    reason: "`data.dob ?? \"\"` / `data.recruitmentNumber ?? \"N/A\"` are display/log-message fields (a log line and an on-screen 'N/A' placeholder), not values fed into a UCPath submission field.",
  },
  "src/workflows/onboarding/workflow.ts": {
    count: 1,
    reason: "`data.dob ?? \"<none>\"` appears only inside a log message template, not decision logic.",
  },
  "src/workflows/person-lookup/workflow.ts": {
    count: 6,
    reason: "`ctx.data.resolvedName ?? ctx.data.searchName ?? \"\"` / `ctx.data.emplId ?? \"\"` / `record.department ?? \"\"`: every one is immediately validated (regex EID format check, `if (!name)` early-return/skip) or is a display field (department) — none is trusted as a real value without a check.",
  },
  "src/workflows/separations/steps/transaction-check.ts": {
    count: 1,
    reason: "`opts.separationDate ?? \"\"` appears only inside a log.debug message template.",
  },
  "src/systems/new-kronos/navigate.ts": {
    count: 1,
    reason: "`row.textContent ?? \"\"` — a DOM read that can legitimately be null (empty cell); immediately regex-cleaned/trimmed, not trusted as a specific value.",
  },
  "src/systems/ucpath/ss-smart-hr.ts": {
    count: 2,
    reason: "`opts.effectiveDate ?? \"<none>\"` / `opts.templateId ?? \"<none>\"` appear only inside a log message template.",
  },
  "src/systems/ucpath/transaction.ts": {
    count: 2,
    reason: "`row.textContent ?? \"\"` — same DOM-read-can-be-null case as new-kronos/navigate.ts.",
  },
  "src/services/address/census.ts": {
    count: 4,
    reason: "`input.street/city/state/zip ?? \"\"` are immediately `.trim()`'d before being sent to the Census geocoding API, which itself validates the address — an absent field becomes an empty string that the API rejects, not a fabricated street/city/state/zip.",
  },
  "src/services/address/format.ts": {
    count: 3,
    reason: "Same address-formatting shape as census.ts: `input.country/zip/state ?? \"\"` are trimmed/cleaned display inputs, not fabricated address data.",
  },
  "src/services/address/nominatim.ts": {
    count: 1,
    reason: "`input.country ?? \"\"` trimmed before geocoding, same shape as census.ts.",
  },
  "src/services/llm/complete.ts": {
    count: 2,
    reason: "`opts.json ?? true` is a declared function-option default (request-JSON-formatted output unless the caller opts out), not a failure-recovery fallback.",
  },
  "src/services/ocr/approval-signal.ts": {
    count: 2,
    reason: "`opts.trackerDir ?? \".tracker\"` is the standard app-level default; `row.error ?? \"operator discarded OCR prep\"` is a discard-reason display string when the operator didn't type one.",
  },
  "src/services/ocr/forms/oath.ts": {
    count: 16,
    reason: "OCR-extracted optional fields (printedName/employeeId/rowIndex/documentType) default to \"\" or the OCR prompt schema's own literal enum sentinels (\"expected\"/\"?\") — every consumer validates format (EID regex) or branches on emptiness before use; documentType's default of \"expected\" is one of exactly two values the OCR prompt schema requires the model to emit (see the prompt's own doc comment).",
  },
  "src/services/ocr/forms/onbase-emergency-contact.ts": {
    count: 1,
    reason: "`record.employee.name ?? \"\"` split into first/last name parts — an absent OCR name yields empty parts, not a fabricated name.",
  },
  "src/services/ocr/forms/verify.ts": {
    count: 3,
    reason: "`record.formKind ?? \"unknown\"` is an explicit 'we don't know' sentinel (not a plausible fake form kind); `record.name ?? \"\"` is used only for comparison/carry-forward keying.",
  },
  "src/services/ocr/forms/i9.ts": {
    count: 3,
    reason: "Mirrors verify.ts: `record.formKind ?? \"unknown\"` is the explicit 'we don't know' sentinel; `record.documentType ?? \"expected\"` is the OCR prompt schema's own enum default (same shape as oath/EC); `record.name ?? \"\"` is comparison/carry-forward keying only.",
  },
  "src/workflows/person-match/workflow.ts": {
    count: 2,
    reason: "`input.ssn ?? \"\"` / `input.dob ?? \"\"` — searchPerson treats empty as 'criterion absent' and its own personSearchCriteriaSufficient gate THROWS when both are empty (the schema also rejects that input at enqueue); never treated as a real SSN/DOB.",
  },
};

const FIX_GUIDANCE =
  "Root CLAUDE.md 'Fail loud — no unverified silent fallbacks': `?? \"SDCMP\"` " +
  "/ `?? \"queued\"` on corrupted/missing data-shaped input is a bug, not " +
  "resilience — it substitutes a plausible-but-wrong business value instead " +
  "of surfacing the absence. Fix: throw naming the offending field, or use " +
  "a value the immediate caller validates/branches on as 'absent' (empty " +
  "string checked before use, an explicit sentinel like 'unknown' that is " +
  "never treated as a real code) rather than a value that could pass as " +
  "real data. If already safe, add/adjust its { count, reason } entry in " +
  "the ALLOWLIST here.";

describe("fail-loud guard: nullish-literal data fallbacks", () => {
  it("every `data.x ?? <literal>` in core/control/tracker/workflows/systems/services is allowlisted with a justification", () => {
    const found = new Map<string, number>();
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const content = readFileSync(file, "utf8");
        let n = 0;
        for (const line of content.split("\n")) {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*")) continue;
          NULLISH_LITERAL_RE.lastIndex = 0;
          while (NULLISH_LITERAL_RE.exec(line)) n++;
        }
        if (n > 0) found.set(rel(file), n);
      }
    }

    const violations: string[] = [];
    for (const [file, n] of found) {
      const entry = ALLOWLIST[file];
      if (!entry) {
        violations.push(`${file}: ${n} unallowlisted nullish-literal data fallback(s) — new occurrence introduced outside the allowlist.`);
        continue;
      }
      if (entry.count !== n) {
        violations.push(
          `${file}: allowlisted for ${entry.count} occurrence(s) but found ${n} — update the ALLOWLIST count (and reason, if the shape changed).`,
        );
      }
    }
    for (const file of Object.keys(ALLOWLIST)) {
      if (!found.has(file)) {
        violations.push(`${file}: allowlisted for ${ALLOWLIST[file].count} occurrence(s) but none found anymore — remove the stale entry.`);
      }
    }

    assert.deepEqual(violations, [], `\n${FIX_GUIDANCE}\n\n${violations.join("\n")}`);
  });
});
