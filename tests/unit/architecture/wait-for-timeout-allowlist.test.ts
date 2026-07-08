import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: every `waitForTimeout(` in src/workflows/ and src/systems/ must be
 * accounted for in the allowlist below (per-file count + a one-line reason).
 *
 * A fixed `waitForTimeout` is exactly the kind of "unverified" wait the root
 * CLAUDE.md fail-loud rule warns about when it stands in for a real
 * readiness check: it either fires too early (racing a slow render — see
 * `src/systems/new-kronos/CLAUDE.md` 2026-06-24, `src/systems/ucpath/
 * CLAUDE.md` 2026-06-22) or wastes time firing long after the page is ready.
 * Two recent sleep-elimination passes replaced most fixed sleeps with
 * condition-based polling; what's left here is either a documented
 * genuinely-fixed delay (e.g. old-kronos's 80ms JQX typing debounce) or a
 * TODO(live-verify)-marked keep where no reliable DOM signal has been found
 * yet (e.g. emergency-contact/enter.ts).
 *
 * This is a RATCHET: it fails on ANY new `waitForTimeout(` in these two
 * trees that isn't already counted here (new file, or a file's count going
 * up), so a sleep can't quietly slip back in after a hardening pass. It also
 * fails if an allowlisted count drops (the entry is now stale) so the
 * allowlist can't silently over-count forever — update the count and, if the
 * remaining sleeps changed shape, the reason.
 */

const ROOT = process.cwd();
const SCAN_ROOTS = [join(ROOT, "src", "workflows"), join(ROOT, "src", "systems")];

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

/** file (relative to repo root) -> { count, reason } */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/workflows/emergency-contact/enter.ts": {
    count: 2,
    reason: "TODO(live-verify)-marked: no detectable post-fill DOM condition for a plain text field / the Phone field specifically — see inline comments.",
  },
  "src/workflows/old-kronos-reports/workflow.ts": {
    count: 1,
    reason: "Legacy old-kronos Reports page settle; no stable readiness selector identified yet.",
  },
  "src/workflows/onboarding/enter.ts": {
    count: 1,
    reason: "I-9 document-interstitial settle wait; no reliable readiness signal on that page.",
  },
  "src/workflows/onboarding/workflow.ts": {
    count: 2,
    reason: "i9/UCPath cross-system settle waits inside the parallel-staggered auth path.",
  },
  "src/workflows/separations/steps/kronos-search.ts": {
    count: 1,
    reason: "Old Kronos search-results grid settle; grid render has no consistent completion signal.",
  },
  "src/workflows/sharepoint-download/download.ts": {
    count: 5,
    reason: "SharePoint's dynamic file-grid UI has no reliable network-idle/render-complete signal across its several steps.",
  },
  "src/workflows/work-study/enter.ts": {
    count: 4,
    reason: "UCPath work-study grid/sidebar settle waits; PeopleSoft grids do not reliably raise a processing/spinner state for these.",
  },
  "src/systems/crm/idocs-download.ts": {
    count: 1,
    reason: "CRM iDocs download page settle; no stable readiness selector identified yet.",
  },
  "src/systems/i9/create.ts": {
    count: 3,
    reason: "i9 dialog/banner settle waits around record-creation confirmation UI.",
  },
  "src/systems/i9/navigate.ts": {
    count: 1,
    reason: "i9 navigation settle wait.",
  },
  "src/systems/i9/search.ts": {
    count: 1,
    reason: "i9 search-results settle wait.",
  },
  "src/systems/kuali/navigate.ts": {
    count: 4,
    reason: "Kuali form-render settle waits; no consistent processing indicator for these steps.",
  },
  "src/systems/new-kronos/navigate.ts": {
    count: 29,
    reason: "New Kronos (WFD) is an Angular app with no consistent readiness signal across its many dropdown/grid renders — extensively documented in src/systems/new-kronos/LESSONS.md and CLAUDE.md (2026-06-24 lesson: a removed fixed 2s sleep here already caused a real production miss).",
  },
  "src/systems/old-kronos/navigate.ts": {
    count: 29,
    reason: "Legacy JQX-grid UI including the documented 80ms JQX typing debounce (see root task context); the rest are settle waits for a UI with no reliable processing signal.",
  },
  "src/systems/old-kronos/reports.ts": {
    count: 11,
    reason: "Same legacy old-kronos JQX-grid UI, Reports flow — no reliable readiness signal.",
  },
  "src/systems/onbase/navigate.ts": {
    count: 6,
    reason: "OnBase Unity Client form settle waits; no consistent processing indicator.",
  },
  "src/systems/ucpath/job-summary.ts": {
    count: 3,
    reason: "PeopleSoft Job Summary tab/grid settle; see the 2026-06-22 CLAUDE.md lesson on this grid not reliably raising the processing spinner.",
  },
  "src/systems/ucpath/navigate.ts": {
    count: 6,
    reason: "PeopleSoft navigation / modal-mask teardown settle waits.",
  },
  "src/systems/ucpath/person-org-summary.ts": {
    count: 8,
    reason: "PeopleSoft Person Org Summary iframe settle waits across several sub-views.",
  },
  "src/systems/ucpath/personal-data.ts": {
    count: 7,
    reason: "PeopleSoft Personal Data page settle waits across its dialogs/rows.",
  },
  "src/systems/ucpath/ss-smart-hr.ts": {
    count: 5,
    reason: "Smart HR transaction submit settle waits.",
  },
  "src/systems/ucpath/transaction.ts": {
    count: 18,
    reason: "PeopleSoft transaction save/submit is the heaviest, most PeopleSoft-processing-dependent UI in the codebase; no consistent completion signal across its many save/readback steps.",
  },
};

function countWaitForTimeout(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/waitForTimeout\(/.test(line)) n++;
  }
  return n;
}

const FIX_GUIDANCE =
  "Root CLAUDE.md 'Fail loud — no unverified silent fallbacks' + the fixed-" +
  "sleep incidents in src/systems/new-kronos/CLAUDE.md (2026-06-24) and " +
  "src/systems/ucpath/CLAUDE.md (2026-06-22): a fixed waitForTimeout that " +
  "stands in for a real readiness check races the render it's waiting on. " +
  "Fix: replace with a condition-based wait (poll for the element/state you " +
  "actually need, e.g. via a helper like pollForJobInfoScan). If a fixed " +
  "delay is genuinely the only option (a documented typing debounce, or a " +
  "live-verify TODO with no known DOM signal yet), add/adjust its { count, " +
  "reason } entry in the ALLOWLIST here.";

describe("fail-loud guard: waitForTimeout allowlist in workflows/systems", () => {
  it("every waitForTimeout( in src/workflows/ and src/systems/ is accounted for", () => {
    const found = new Map<string, number>();
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of walk(scanRoot)) {
        const content = readFileSync(file, "utf8");
        const n = countWaitForTimeout(content);
        if (n > 0) found.set(rel(file), n);
      }
    }

    const violations: string[] = [];
    for (const [file, n] of found) {
      const entry = ALLOWLIST[file];
      if (!entry) {
        violations.push(`${file}: ${n} unallowlisted waitForTimeout( call(s)) — new sleep introduced outside the allowlist.`);
        continue;
      }
      if (entry.count !== n) {
        violations.push(
          `${file}: allowlisted for ${entry.count} waitForTimeout( call(s)) but found ${n} — update the ALLOWLIST count (and reason, if the shape changed).`,
        );
      }
    }
    for (const file of Object.keys(ALLOWLIST)) {
      if (!found.has(file)) {
        violations.push(`${file}: allowlisted for ${ALLOWLIST[file].count} waitForTimeout( call(s)) but none found anymore — remove the stale entry.`);
      }
    }

    assert.deepEqual(violations, [], `\n${FIX_GUIDANCE}\n\n${violations.join("\n")}`);
  });
});
