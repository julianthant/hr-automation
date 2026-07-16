import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: "fail loud — no unverified silent fallbacks" (root CLAUDE.md, "Fail
 * loud — no unverified silent fallbacks" section).
 *
 * A `catch` that swallows an error and returns/assigns a bare default
 * (`null|undefined|[]|{}|true|false|0|""`) with NO other statement in its
 * body is the exact "catch { return [] }" / "catch { won = true }" shape the
 * rule calls out as the single most dangerous pattern in this codebase — it
 * makes "the operation failed" indistinguishable from "the operation
 * succeeded with an empty/negative result". Same idea for the promise-chain
 * form `.catch(() => <bareDefault>)`.
 *
 * This is a RATCHET, not a rewrite: every catch of this shape that exists in
 * the tree today has been read in context and is allowlisted below with a
 * one-line reason (documented best-effort contract, cosmetic UI/localStorage
 * state, or a value that's validated/branched-on immediately after — never
 * trusted as real data). New occurrences must get the same review, not a
 * silent add to the allowlist.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

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

// ---------------------------------------------------------------------------
// Pattern A: `catch { <single bare-default statement> }` (try/catch form)
// ---------------------------------------------------------------------------

const BARE_DEFAULT_STATEMENT =
  /^\s*(return\s+(null|undefined|\[\]|\{\}|true|false|0|"")|(\w+)\s*=\s*(null|undefined|\[\]|\{\}|true|false|0|""))\s*;?\s*$/;

interface CatchBody {
  start: number;
  body: string;
}

function findCatchBlocks(content: string): CatchBody[] {
  const out: CatchBody[] = [];
  const re = /catch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < content.length && depth > 0; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
    }
    out.push({ start: m.index, body: content.slice(bodyStart, i - 1) });
  }
  return out;
}

/** file (relative to repo root) -> { count, reason } */
const STATEMENT_CATCH_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/control/actions/perform-workflow-action.ts": {
    count: 1,
    reason: "emitDashboardCancelTrackerRow's catch is commented in place: falls back to the caller's original error rather than claiming success.",
  },
  "src/control/ops/worker-control.ts": {
    count: 1,
    reason: "POST /stop fetch failure -> false ('did not confirm stop'); caller already treats false as failure, not success.",
  },
  "src/core/daemon/registry.ts": {
    count: 4,
    reason: "readLockfile/isProcessAlive: documented contract ('Never throws — callers treat null/false as invalid/dead, ignore') — see the function's own doc comment.",
  },
  "src/core/kernel/session.ts": {
    count: 11,
    reason: "Browser-health probes (isClosed/evaluate-liveness/screenshot/scroll-plan) — every one is inline-commented 'best-effort' and a thrown probe already means the browser/page is in a degraded state the caller treats as unhealthy.",
  },
  "src/dashboard/components/hooks/usePostAction.ts": {
    count: 1,
    reason: "Deliberate fail-loud shape: body defaults to undefined so the immediately-following `bodyOk = body && ok === true` check treats a malformed response as failure, never success (see inline 'Fail loud' comment).",
  },
  "src/dashboard/components/hooks/useTerminalDrawer.tsx": {
    count: 1,
    reason: "Client-only UI preference (drawer open/closed) read from localStorage — not HR transaction data; a parse failure safely degrades to the closed default.",
  },
  "src/dashboard/components/hooks/useWorkflowActionDispatcher.ts": {
    count: 1,
    reason: "Same fail-loud shape as usePostAction.ts: body -> undefined so the ok===true check downstream treats a malformed body as failure.",
  },
  "src/dashboard/components/log-panel/EidApprovalBanner.tsx": {
    count: 1,
    reason: "Same fail-loud shape: json -> null so `res.ok && json?.ok === true` treats an unparseable body as failure on the highest-stakes (wrong-EID) gate — see inline 'Fail loud' comment.",
  },
  "src/dashboard/components/navigation/NotificationBell.tsx": {
    count: 2,
    reason: "Cosmetic UI: localStorage counter read + relative-time formatting. Not transactional data.",
  },
  "src/dashboard/components/navigation/SearchResults.tsx": {
    count: 1,
    reason: "Cosmetic relative-time-ago string formatting for a search result row.",
  },
  "src/dashboard/components/ocr/types.ts": {
    count: 4,
    reason: "Malformed `records` JSON on an OCR preview row -> null (the whole preview row fails to render); it is a read-side preview projection, not the authoritative tracker record. (4th: the i9 parser mirrors the EC/oath/verify parsers.)",
  },
  "src/dashboard/components/ui/calendar.tsx": {
    count: 1,
    reason: "Unparseable selected date string for the calendar widget -> undefined (no date highlighted); cosmetic UI state.",
  },
  "src/dashboard/components/workflow-modifier/graph/data-bank-dnd.ts": {
    count: 1,
    reason: "Documented in the function's own doc comment: a drag payload that isn't ours yields null so an errant drop is a no-op, not a crash.",
  },
  "src/dashboard/components/workflow-modifier/graph/useRecentOps.ts": {
    count: 1,
    reason: "Cosmetic 'recent operations' localStorage list for the Workflow Editor UI, not live HR data.",
  },
  "src/dashboard/components/workflow-modifier/useWorkflowDesign.ts": {
    count: 2,
    reason: "Workflow Editor design-intent scaffold save/delete (dev tooling, config/workflow-design/*.json) — a network failure degrades to 'not saved', which is a real, surfaced state, not a live HR transaction.",
  },
  "src/dashboard/components/workflow-modifier/useWorkflowPresentation.ts": {
    count: 2,
    reason: "Same as useWorkflowDesign.ts: presentation-override save/delete for the Workflow Editor UI, not a live HR transaction.",
  },
  "src/infra/auth/duo-webauthn.ts": {
    count: 4,
    reason: "isProcessAlive (ESRCH/EPERM -> not-alive) mirrors the documented tracker/session-events.ts isPidAlive contract; isDuoWebAuthnLockStale's mtime-check catch only fires once both owner.json AND the lock dir itself are already gone (a self-correcting race — the subsequent rmSync/mkdirSync no-ops); reserveDuoWebAuthnSignCounts' read/write-failure `false` is THROWN on by its only caller (arm(), 'could not reserve Duo WebAuthn signCount before arming') rather than treated as success.",
  },
  "src/infra/auth/sso-fields.ts": {
    count: 2,
    reason: "isSsoFormReady/waitForSsoForm: a thrown Playwright count()/waitFor() means the SSO submit button isn't there/visible yet, which is exactly what returning false communicates to the caller.",
  },
  "src/scripts/ops/clean-tracker.ts": {
    count: 1,
    reason: "CLI cleanup script: a missing uploads dir is a genuinely valid 'nothing to clean' state.",
  },
  "src/scripts/selectors/catalog.ts": {
    count: 1,
    reason: "Dev-only selector catalog generator: statSync failure on a candidate selectors.ts just means 'this dir isn't a system', a valid filter outcome.",
  },
  "src/scripts/selectors/search.ts": {
    count: 1,
    reason: "Dev-only selector search CLI: tryRead returns null for a missing/unreadable file, which the caller treats as 'nothing to search here'.",
  },
  "src/services/capture/ngrok.ts": {
    count: 1,
    reason: "Parses one line of the locally-spawned ngrok process's own JSON log output; a malformed line is skipped (null), not treated as tunnel data.",
  },
  "src/services/matching/roster-loader.ts": {
    count: 2,
    reason: "Roster directory listing / per-file stat: a missing dir or a file that vanishes mid-stat is a genuinely valid 'no rosters yet' / 'skip this one' outcome for a listing helper.",
  },
  "src/services/ocr/approval-signal.ts": {
    count: 2,
    reason: "Malformed `records`/string-array JSON on an approval-signal row degrades to []/undefined for what is a best-effort read of denormalized OCR status, not the authoritative record.",
  },
  "src/services/ocr/key-status.ts": {
    count: 1,
    reason: "Malformed persisted OCR-key-health JSON -> {} (no cells known yet); self-healing on the next successful write.",
  },
  "src/services/ocr/lookup-suggestions.ts": {
    count: 1,
    reason: "Malformed LLM lookup-suggestion JSON -> [] (no suggestions offered); the caller already handles an empty suggestion list as a normal outcome.",
  },
  "src/systems/crm/onboarding-records.ts": {
    count: 1,
    reason: "Pure helper documented in its own doc comment: an unparseable URL fails the host-equality check (false), the correct behavior for an invalid URL.",
  },
  "src/systems/onbase/page-state.ts": {
    count: 1,
    reason: "Doc comment: 'a frame detached mid-read degrades to not seen' — a session-contention probe across every frame, best-effort by design.",
  },
  "src/tracker/dashboard/capture-state.ts": {
    count: 1,
    reason: "Optional bundled heic2any dev asset: missing/unreadable file -> undefined, a real 'asset not available' state the caller already handles.",
  },
  "src/tracker/dashboard/ocr/reocr-whole-pdf.ts": {
    count: 1,
    reason: "Malformed `parallelWorkers` row field -> undefined (kernel's own default applies); the row's real fields are read from elsewhere already.",
  },
  "src/tracker/dashboard/ocr/shared.ts": {
    count: 1,
    reason: "Same `parallelWorkers` parse as reocr-whole-pdf.ts -> undefined, kernel default applies.",
  },
  "src/tracker/dashboard/prep-rows.ts": {
    count: 1,
    reason: "Malformed `records` JSON on a prep row -> undefined record count, used only for a display badge.",
  },
  "src/tracker/delegation/watch-child-runs.ts": {
    count: 1,
    reason: "statSync failure reading an abort-sentinel file -> false ('not aborted'); a missing sentinel is the common, valid case already checked by existsSync above it.",
  },
  "src/tracker/jsonl-cleanup.ts": {
    count: 2,
    reason: "Cleanup sweep: a missing sessions/daemons dir is a genuinely valid 'nothing to clean' state (mirrors clean-tracker.ts).",
  },
  "src/tracker/session-events.ts": {
    count: 1,
    reason: "isPidAlive: doc comment explicitly documents treating EPERM as dead 'so stale orphans from other users/containers don't block instance numbering' — a verified, deliberate trade-off.",
  },
  "src/tracker/sessions/duo-queue.ts": {
    count: 1,
    reason: "Same isPidAlive shape as session-events.ts / registry.ts — process.kill(pid,0) throwing means not-alive for this queue's purposes.",
  },
  "src/tracker/state/db.ts": {
    count: 1,
    reason: "statSync failure fingerprinting the SQLite file -> null, meaning 'no fingerprint yet' (file doesn't exist), a valid state for a cache-invalidation check.",
  },
  "src/tracker/tail-incremental.ts": {
    count: 2,
    reason: "Incremental tail helper: a stat/read failure on a rotated/removed log file yields no new lines ([]), which is correct — there is nothing to tail.",
  },
  "src/tracker/tasks/ocr-continuation.ts": {
    count: 1,
    reason: "Malformed continuation-record JSON -> null; caller already branches on a null continuation as 'nothing to continue'.",
  },
  "src/workflows/oath-signature/enter.ts": {
    count: 1,
    reason: "Doc comment: 'Best-effort: a miss leaves it empty and the handler falls back to the CRM signed date' — the fallback is documented and verified.",
  },
  "src/workflows/oath-upload/duplicate-check.ts": {
    count: 1,
    reason: "Malformed per-row data_json while scanning JSONL history for a prior-run hash match -> {} for that one row only; this is an informational duplicate-history surface, not the authoritative dedup gate (the sha256-registered-file check in ocr/prepare.ts is).",
  },
  "src/workflows/oath-upload/fill-form.ts": {
    count: 1,
    reason: "Pure helper: an unparseable ServiceNow redirect URL yields null ticket number, the correct behavior for a URL that isn't the expected redirect shape.",
  },
  "src/workflows/ocr/retry-page.ts": {
    count: 4,
    reason: "Retry-page preview parsing (row projection / failed-pages / page-summary JSON) — all read-side helpers for the OCR retry UI; a malformed field degrades that one display, not the underlying row.",
  },
  "src/workflows/old-kronos-reports/workflow.ts": {
    count: 1,
    reason: "Inline comment: 'Both attempts failed — fall through to the tracker write below' — already retried (attempts: 2) above; success=false feeds the row-failure write immediately after.",
  },
};

// ---------------------------------------------------------------------------
// Pattern B: `.catch(() => <bareDefault>)` promise-chain arrow form
// ---------------------------------------------------------------------------

const CATCH_ARROW_DEFAULT =
  /\.catch\(\s*(?:\([^)]*\)|\w+)\s*=>\s*(null|undefined|false|true|0|""|''|\[\]|\(\{\}\))\s*\)/g;

// Playwright/Node query-or-action method names whose OWN promise this catch
// is guarding. Swallowing a rejection from one of these (isVisible/count/
// textContent/evaluate/click/goto/...) and substituting `false`/`""`/`0`/
// `null` is the well-established "optional/best-effort UI probe" idiom this
// codebase uses pervasively (hundreds of call sites) — see root CLAUDE.md's
// "Not a fallback" carve-out. Excluded here so the guard focuses on
// `.catch(() => <default>)` on business/data-shaped promises instead.
const PLAYWRIGHT_PROBE_METHODS = [
  "isVisible", "isEnabled", "isChecked", "isDisabled", "isEditable", "count",
  "textContent", "innerText", "inputValue", "getAttribute", "evaluate",
  "waitFor", "boundingBox", "screenshot", "click", "hover", "fill", "press",
  "selectOption", "check", "uncheck", "focus", "blur",
  "scrollIntoViewIfNeeded", "dispatchEvent", "close", "detach", "send",
  "goto", "waitForLoadState", "waitForTimeout", "waitForURL", "reload",
  "dismiss", "accept", "json", "title", "content",
];
const PLAYWRIGHT_PROBE_RE = new RegExp(`\\.(${PLAYWRIGHT_PROBE_METHODS.join("|")})\\(`);
const BACKWARD_WINDOW = 2000;

const ARROW_CATCH_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/infra/auth/duo-poll.ts": {
    count: 1,
    reason: "Caller-supplied `successCheck(page)` during the cached-trust pre-check throws -> treated as not-verified (false), which falls through to the normal Duo flow instead of wrongly skipping it — the safe direction.",
  },
  "src/tracker/dashboard/capture-state.ts": {
    count: 1,
    reason: "`void ensurePdfPageCache(...).catch(() => undefined)` — an explicitly voided, fire-and-forget page-preview cache warm-up; failure is discarded because the call isn't awaited and the cache is a performance nicety, not correctness-bearing.",
  },
  "src/tracker/dashboard/hono/routes/ocr.ts": {
    count: 1,
    reason: "Same voided fire-and-forget ensurePdfPageCache warm-up as capture-state.ts.",
  },
  "src/tracker/dashboard/sweeps.ts": {
    count: 1,
    reason: "Inline comment: 'loadWorkflow may return null for in-process workflows (ocr, sharepoint-download) that don't show up in the daemon queue anyway' — a documented, valid null.",
  },
};

function scanStatementCatches(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const content = readFileSync(file, "utf8");
    const hits: string[] = [];
    for (const { start, body } of findCatchBlocks(content)) {
      const codeLines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      if (codeLines.length !== 1) continue;
      if (BARE_DEFAULT_STATEMENT.test(codeLines[0])) {
        const lineNo = content.slice(0, start).split("\n").length;
        hits.push(`${lineNo}: catch { ${codeLines[0]} }`);
      }
    }
    if (hits.length > 0) found.set(rel(file), hits);
  }
  return found;
}

function scanArrowCatches(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const content = readFileSync(file, "utf8");
    const hits: string[] = [];
    CATCH_ARROW_DEFAULT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CATCH_ARROW_DEFAULT.exec(content))) {
      const lineText = content.split("\n")[content.slice(0, m.index).split("\n").length - 1];
      const trimmed = lineText.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      const windowStart = Math.max(0, m.index - BACKWARD_WINDOW);
      const preceding = content.slice(windowStart, m.index);
      if (PLAYWRIGHT_PROBE_RE.test(preceding)) continue;
      const lineNo = content.slice(0, m.index).split("\n").length;
      hits.push(`${lineNo}: ${trimmed.slice(0, 140)}`);
    }
    if (hits.length > 0) found.set(rel(file), hits);
  }
  return found;
}

function checkAgainstAllowlist(
  found: Map<string, string[]>,
  allowlist: Record<string, { count: number; reason: string }>,
  patternLabel: string,
): string[] {
  const violations: string[] = [];
  for (const [file, hits] of found) {
    const entry = allowlist[file];
    if (!entry) {
      violations.push(
        `${file} has ${hits.length} new unallowlisted "${patternLabel}" occurrence(s):\n` +
          hits.map((h) => `    ${file}:${h}`).join("\n"),
      );
      continue;
    }
    if (entry.count !== hits.length) {
      violations.push(
        `${file}: allowlisted count is ${entry.count} but found ${hits.length} "${patternLabel}" occurrence(s) — update the allowlist count (and its reason, if the shape changed):\n` +
          hits.map((h) => `    ${file}:${h}`).join("\n"),
      );
    }
  }
  for (const file of Object.keys(allowlist)) {
    if (!found.has(file)) {
      violations.push(
        `${file}: allowlisted for ${allowlist[file].count} "${patternLabel}" occurrence(s) but none found anymore — remove the stale allowlist entry.`,
      );
    }
  }
  return violations;
}

const FIX_GUIDANCE =
  "Root CLAUDE.md 'Fail loud — no unverified silent fallbacks': a catch that " +
  "returns/assigns a bare default and lets execution continue must instead " +
  "re-throw, or log.warn AND propagate a distinguishable value the caller " +
  "checks — never let 'the check failed' become indistinguishable from 'the " +
  "check passed / found nothing'. Fix: re-throw, or make the default a value " +
  "the immediate caller explicitly branches on as a failure. If the fallback " +
  "is genuinely verified-safe (see the two-part test in CLAUDE.md), add a " +
  "{ count, reason } entry to the allowlist in this file with a one-line " +
  "justification citing what makes it safe.";

describe("fail-loud guard: catch blocks returning a bare default", () => {
  it("every `catch { <bare default> }` in src/ is allowlisted with a justification", () => {
    const found = scanStatementCatches();
    const violations = checkAgainstAllowlist(found, STATEMENT_CATCH_ALLOWLIST, "catch { bare default }");
    assert.deepEqual(violations, [], `\n${FIX_GUIDANCE}\n\n${violations.join("\n\n")}`);
  });

  it("every `.catch(() => <bare default>)` in src/ (excluding Playwright probe chains) is allowlisted with a justification", () => {
    const found = scanArrowCatches();
    const violations = checkAgainstAllowlist(found, ARROW_CATCH_ALLOWLIST, ".catch(() => bare default)");
    assert.deepEqual(violations, [], `\n${FIX_GUIDANCE}\n\n${violations.join("\n\n")}`);
  });
});
