/**
 * Contract 5 Phase 1 — Unified cancel mechanism (architecture guard).
 *
 * Post Phase 1, the codebase has exactly ONE in-process cancel mechanism:
 *
 *   1. `runRegistry.register(handle)` / `runRegistry.unregister(runId)` —
 *      every `runOneItem` / `runWorkflow` invocation registers a
 *      `RunHandle` (with its `AbortController` and `Session`) on entry and
 *      unregisters in `finally`.
 *   2. `runRegistry.cancel(runId, opts)` — every cancel trigger (daemon
 *      worker-command `cancel_task`, HTTP `/cancel-current`,
 *      browser-disconnect handler, dashboard in-process cancel route,
 *      daemon shutdown sweep, scenario-test cancel) flows through this
 *      one entry point.
 *
 * Pre-Phase-1, two parallel runtimes existed: the daemon's
 * `state.cancelTarget` + `state.currentRunController` pair, and a separate
 * `Map` in `daemon/in-process-runs.ts` with its own
 * `registerInProcessRun` / `unregisterInProcessRun` / `cancelInProcessRun`
 * API plus a direct `session.killChromeHard()` call (the controller was
 * NOT wired through that path).
 *
 * This guard blocks reintroduction of either mechanism. If you find
 * yourself wanting to add a new `state.cancelTarget`-style field or a
 * second registry Map, route the call through `runRegistry.cancel`
 * instead — the watchdog hard-kill fallback inside it covers the rare
 * cases (pre-handler launch hang, e.g. stuck on Duo) where the
 * AbortController has no observer yet.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listSourceFiles, stripCommentsPreserveLines } from "../../_utils/source-scanner.js";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const ALL_SRC_FILES = listSourceFiles(SRC_DIR);

/**
 * Files allowed to mention legacy identifiers — they're the new module
 * itself and a handful of CLAUDE.md-adjacent doc comments that explain
 * "what this code REPLACES". Source-scanner already strips comments so
 * legitimate doc references are filtered out automatically; this list is
 * the safety net for cases where the identifier appears inside a string
 * literal or other live code (e.g. log messages explaining migration).
 */
const LEGACY_NAME_ALLOWLIST = new Set([
  "src/core/run-registry.ts",
]);

test("no references to legacy `state.cancelTarget` or `state.currentRunController`", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  const pattern = /\bstate\s*\.\s*(cancelTarget|currentRunController)\b/;
  for (const file of ALL_SRC_FILES) {
    const rel = relative(ROOT, file);
    if (LEGACY_NAME_ALLOWLIST.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      if (!pattern.test(line)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "Legacy `state.cancelTarget` / `state.currentRunController` reference reintroduced. " +
      "Phase 1 collapsed both into `state.activeRun: RunHandle | null` and " +
      "routes every cancel through `runRegistry.cancel(runId)`. " +
      "If you need to cancel a run, call `runRegistry.cancel(runId, { reason })`.\n" +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});

test("no references to legacy in-process-runs API (`registerInProcessRun` / `unregisterInProcessRun` / `cancelInProcessRun`)", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  const pattern = /\b(registerInProcessRun|unregisterInProcessRun|cancelInProcessRun)\b/;
  for (const file of ALL_SRC_FILES) {
    const rel = relative(ROOT, file);
    if (LEGACY_NAME_ALLOWLIST.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      if (!pattern.test(line)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "Legacy in-process-runs API reference reintroduced. " +
      "Phase 1 deleted `src/core/daemon/in-process-runs.ts` and routed every " +
      "in-process cancel through `runRegistry.cancel(runId)`. " +
      "Registration happens automatically inside `runOneItem` / `runWorkflow` — " +
      "callers never need to register/unregister manually.\n" +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});

/**
 * Allow-list for files that legitimately call `session.killChromeHard()`:
 *   - `run-registry.ts` is the canonical cancellation watchdog site.
 *   - `kernel/run-workflow.ts` uses it in its own `finally` cleanup path
 *     to tear down the session it owns when the run ends (independently
 *     of cancellation).
 *   - `daemon/shutdown.ts` uses it as the post-grace teardown step in the
 *     daemon shutdown sequence (separate from the per-run cancel watchdog).
 *   - `kernel/session.ts` is the implementation file.
 */
const KILL_CHROME_HARD_ALLOWLIST = new Set([
  "src/core/run-registry.ts",
  "src/core/kernel/run-workflow.ts",
  "src/core/kernel/session.ts",
  "src/core/daemon/shutdown.ts",
]);

test("no direct `session.killChromeHard()` calls outside `runRegistry`/`shutdown` — route cancel through `runRegistry.cancel`", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  const pattern = /\bkillChromeHard\s*\(/;
  for (const file of ALL_SRC_FILES) {
    const rel = relative(ROOT, file);
    if (KILL_CHROME_HARD_ALLOWLIST.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      if (!pattern.test(line)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "Direct `killChromeHard()` call found outside the allow-listed cancel-mechanism files. " +
      "Phase 1 made `killChromeHard` a watchdog fallback inside `runRegistry.cancel` — " +
      "callers asking to cancel a run should call `runRegistry.cancel(runId, { reason })` " +
      "and let the registry decide whether to hard-kill chromium.\n" +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});
