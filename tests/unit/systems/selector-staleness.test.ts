import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Guard: selectors must be re-verified within the staleness window.
 *
 * Selector drift is a top source of silent breakage — PeopleSoft / UKG /
 * Kuali change anchor IDs without warning. Each selector in
 * `src/systems/<system>/selectors.ts` should carry a `// verified YYYY-MM-DD`
 * comment that reflects when it was last confirmed against the live system
 * via playwright-cli snapshot. This test fails when any such comment is
 * older than the threshold, nudging re-verification BEFORE the selector
 * actually rots.
 *
 * Threshold: 90 days by default. Override via `SELECTOR_STALENESS_DAYS` env
 * var for CI flexibility (e.g. tighten to 60 before release, loosen for
 * long-running legacy branches).
 *
 * This test only reads selector files — it does NOT update them. Re-verifying
 * a selector is a manual act: map the element fresh via playwright-cli,
 * confirm the selector still matches, then update the `verified` comment.
 */

const SYSTEMS_DIR = path.resolve(
  new URL("../../../src/systems", import.meta.url).pathname,
);

const DEFAULT_THRESHOLD_DAYS = 90;

function thresholdDays(): number {
  const raw = process.env.SELECTOR_STALENESS_DAYS;
  if (!raw) return DEFAULT_THRESHOLD_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_THRESHOLD_DAYS;
  return parsed;
}

/** Pattern matches `verified 2026-04-16` anywhere in a line. */
const VERIFIED_RE = /verified\s+(\d{4}-\d{2}-\d{2})/g;

interface Finding {
  file: string;
  line: number;
  verified: string;
  ageDays: number;
}

async function findSelectorFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Recurse one level — systems/<name>/selectors.ts
      const inner = await fs.readdir(p, { withFileTypes: true });
      for (const ie of inner) {
        if (ie.isFile() && ie.name === "selectors.ts") {
          out.push(path.join(p, ie.name));
        }
      }
    }
  }
  return out;
}

describe("selector-staleness guard", () => {
  it("no `// verified YYYY-MM-DD` comment in src/systems/<name>/selectors.ts is older than threshold", async () => {
    const files = await findSelectorFiles(SYSTEMS_DIR);
    assert.ok(files.length > 0, "expected at least one selectors.ts file");

    const threshold = thresholdDays();
    const now = Date.now();
    const findings: Finding[] = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Walk all matches on this line (some lines have multiple, e.g. "verified
        // 2026-03-16 (id: ...)" alongside another remark).
        for (const m of line.matchAll(VERIFIED_RE)) {
          const dateStr = m[1];
          const parsed = Date.parse(dateStr + "T00:00:00Z");
          if (!Number.isFinite(parsed)) continue;
          const ageDays = Math.floor((now - parsed) / (24 * 60 * 60 * 1000));
          if (ageDays > threshold) {
            findings.push({
              file: path.relative(process.cwd(), file),
              line: i + 1,
              verified: dateStr,
              ageDays,
            });
          }
        }
      }
    }

    if (findings.length > 0) {
      const msg = findings
        .map(
          (f) =>
            `  ${f.file}:${f.line} verified ${f.verified} (${f.ageDays} days old)`,
        )
        .join("\n");
      assert.fail(
        `Found ${findings.length} selector${findings.length === 1 ? "" : "s"} verified > ${threshold} days ago:\n${msg}\n\n` +
          `Fix: re-map the selector live via playwright-cli snapshot, confirm it still matches,\n` +
          `and update the verified date comment. Do NOT just bump the date — run the mapping.\n` +
          `Override threshold via SELECTOR_STALENESS_DAYS env var if a re-verification is scheduled.`,
      );
    }
  });
});
