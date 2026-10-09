/**
 * Contract 1 — Archetype Stamping (architecture guard).
 *
 * Every tracker row persisted to disk must carry `data.archetype` stamped at
 * emit time. The canonical write path is `emitTrackerRow` in
 * `src/tracker/jsonl-io.ts`, which requires `data: StampedData` (`Record<
 * string, string> & { archetype: RowArchetype }`) at the type level. The
 * legacy `trackEvent` / `trackEventForDate` aliases remain for the SIGINT
 * fallback in `tracked-workflow.ts` and for migration-period back-compat, but
 * production emit sites must use `emitTrackerRow` so the compiler rejects any
 * row that drops `data.archetype`.
 *
 * This guard:
 *   1. Forbids new uses of `trackEvent(` / `trackEventForDate(` outside the
 *      allow-listed tracker-internal and SIGINT files.
 *   2. Forbids direct `appendFileSync` writes to `*.jsonl` paths anywhere
 *      under `src/` except inside `src/tracker/` (where the JSONL primitives
 *      legitimately own that I/O).
 *   3. Asserts `emitTrackerRow` is exported from the tracker barrel.
 *
 * If you have a new emit site, route it through `emitTrackerRow` and stamp
 * archetype via `stampArchetypeForRow` (or pass an explicit override). Do
 * NOT add new entries to the allow-list — open a real PR review instead.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listSourceFiles, stripCommentsPreserveLines } from "../../_utils/source-scanner.js";

import * as trackerBarrel from "../../../src/tracker/jsonl.js";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

/**
 * Files that may continue to call the legacy `trackEvent` aliases:
 *   - jsonl-io.ts: defines them (they wrap writeTrackerEntryRaw + the
 *     SQLite live-apply hook).
 *   - jsonl.ts: barrel re-export.
 *   - tracked-workflow.ts: SIGINT/SIGTERM handler intentionally uses
 *     synchronous appendFileSync because process.exit follows immediately
 *     and async wrappers can't complete in time. The handler's data field
 *     still carries `data.archetype`.
 *
 * Adding to this list should be considered carefully — every entry is a
 * place the compile-time StampedData contract does not protect.
 */
const TRACK_EVENT_ALLOWLIST = new Set<string>([
  "src/tracker/jsonl-io.ts",
  "src/tracker/jsonl.ts",
  "src/tracker/tracked-workflow.ts",
]);

/**
 * Files that may write `*.jsonl` content via direct fs primitives:
 *   - The tracker module owns the on-disk JSONL format end-to-end and uses
 *     appendFileSync inside its public emit helpers + the SIGINT handler.
 *   - control/ops/shared.ts appends to `.tracker/daemons/*.queue.jsonl` —
 *     daemon queue audit lines, not tracker rows.
 *   - core/daemon/queue.ts also writes to the daemon queue audit file.
 *
 * Tracker ROW emissions (the `{workflow}-{date}.jsonl` files) are owned
 * exclusively by jsonl-io.ts.
 */
const JSONL_WRITE_ALLOWLIST = new Set<string>([
  "src/tracker/jsonl-io.ts",
  "src/tracker/jsonl.ts",
  "src/tracker/tracked-workflow.ts",
  "src/tracker/session-events.ts",
  "src/tracker/state/jsonl-source.ts",
  "src/control/ops/shared.ts",
  "src/core/daemon/queue.ts",
]);

const SRC_FILES = listSourceFiles(SRC_DIR);

test("emitTrackerRow is exported from the tracker barrel", () => {
  assert.equal(
    typeof (trackerBarrel as { emitTrackerRow?: unknown }).emitTrackerRow,
    "function",
    "src/tracker/jsonl.ts must re-export emitTrackerRow",
  );
  assert.equal(
    typeof (trackerBarrel as { emitTrackerRowForDate?: unknown }).emitTrackerRowForDate,
    "function",
    "src/tracker/jsonl.ts must re-export emitTrackerRowForDate",
  );
  assert.equal(
    typeof (trackerBarrel as { stampArchetypeForRow?: unknown }).stampArchetypeForRow,
    "function",
    "src/tracker/jsonl.ts must re-export stampArchetypeForRow",
  );
});

test("no new production callers of legacy trackEvent / trackEventForDate", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  // Match call-site usage (followed by '('). Ignore import lines so the
  // barrel re-export and the helper itself stay clean. The grep is line-
  // anchored to avoid catching `emitTrackerRow` substrings.
  const callPattern = /\btrackEvent(?:ForDate)?\s*\(/;

  for (const file of SRC_FILES) {
    const rel = relative(ROOT, file);
    if (TRACK_EVENT_ALLOWLIST.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    // Strip block comments so `/* trackEvent(...) */` doesn't
    // false-positive as a live call site (#17).
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      // Skip import lines + JSDoc references.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("import ") || trimmed.startsWith("* ") || trimmed.startsWith("//")) return;
      if (callPattern.test(line)) {
        offenders.push({ file: rel, line: idx + 1, match: line.trim() });
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Direct trackEvent/trackEventForDate call found — use emitTrackerRow + stampArchetypeForRow so the StampedData contract is enforced at compile time.\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});

test("no direct *.jsonl appendFile writes outside the allow-listed I/O modules", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  // Matches lines that call appendFileSync OR appendFile on a path that
  // ends with ".jsonl" — the legitimate signature for tracker-row writes.
  // Pattern is intentionally generous to catch indirect path construction
  // like `appendFileSync(join(dir, '...jsonl'), ...)`.
  const writePattern = /append(?:File|FileSync)\s*\([^)]*\.jsonl/;

  for (const file of SRC_FILES) {
    const rel = relative(ROOT, file);
    if (JSONL_WRITE_ALLOWLIST.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    // Strip block comments so `/* appendFileSync(...jsonl) */` doesn't
    // false-positive as a live write site (#17).
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("* ")) return;
      if (writePattern.test(line)) {
        offenders.push({ file: rel, line: idx + 1, match: line.trim() });
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Direct *.jsonl append found outside the tracker I/O allowlist — go through emitTrackerRow instead.\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});
