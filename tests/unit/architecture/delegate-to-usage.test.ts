/**
 * Contract 3 — Delegation API (architecture guard).
 *
 * Workflows compose like functions: a parent calls a child via
 * `ctx.delegateTo(child, input, opts)` or `ctx.delegateToAll(child, inputs,
 * opts)`. The kernel handles parentRunId stamping, archetype derivation,
 * pre-emit pending row, and pristine-input persistence in one place.
 *
 * Direct `runWorkflow(child, ..., { parentRunId: ... })` or
 * `ensureDaemonsAndEnqueue(child, ..., { parentRunId: ... })` calls inside
 * a workflow handler BYPASS the kernel's delegation contract — they
 * frequently forget archetype stamping, skip pre-emit, or drop
 * parentRunId on retry. This guard blocks new occurrences.
 *
 * The guard is scoped to `src/workflows/<workflow>/handler.ts` and
 * `workflow.ts` files (the handler body lives in those two files for
 * every workflow). Orchestrator files (`src/workflows/ocr/orchestrator.ts`,
 * `src/workflows/ocr/force-research.ts`, `src/workflows/ocr/retry-page.ts`)
 * remain temporarily allow-listed during the OCR migration — see the
 * `ORCHESTRATOR_ALLOWLIST` constant. New entries require a deliberate
 * review.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listSourceFiles, stripCommentsPreserveLines } from "../../_utils/source-scanner.js";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

/**
 * Allow-listed files that may keep direct delegation calls. Use sparingly
 * and document why in `src/workflows/<workflow>/CLAUDE.md`. The OCR
 * orchestrator owns its own emit/retry/force-research machinery and
 * cannot trivially be migrated piecemeal — track its conversion in a
 * dedicated plan rather than padding this list.
 */
const ORCHESTRATOR_ALLOWLIST = new Set<string>([
  // OCR's force-research and retry-page paths reach into the same
  // dispatch shape from non-handler contexts. They remain on the legacy
  // direct-runWorkflow path pending a dedicated migration plan.
  "src/workflows/ocr/force-research.ts",
  "src/workflows/ocr/retry-page.ts",
]);

const WORKFLOW_FILES = listSourceFiles(SRC_DIR).filter((file) => {
  const rel = relative(ROOT, file);
  return rel.startsWith("src/workflows/")
    && !rel.endsWith(".d.ts")
    && !ORCHESTRATOR_ALLOWLIST.has(rel);
});

test("no direct runWorkflow(..., { parentRunId }) calls inside workflow handlers — use ctx.delegateTo", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  // Match a `runWorkflow(` call site (handler / orchestrator body). The
  // restriction is "with parentRunId option" — we check for the literal
  // `parentRunId` token within the next 5 lines of the call. This is a
  // coarse heuristic but matches the canonical shape every legacy site
  // uses today.
  for (const file of WORKFLOW_FILES) {
    const rel = relative(ROOT, file);
    const raw = readFileSync(file, "utf8");
    // Strip block comments first so `/* runWorkflow(...) */` doesn't
    // false-positive as a live call site (#17).
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("* ") || trimmed.startsWith("import ")) return;
      if (!/\brunWorkflow\s*\(/.test(line)) return;
      // Look ahead up to 5 lines for `parentRunId`.
      const lookahead = lines.slice(idx, idx + 6).join("\n");
      if (!/\bparentRunId\b/.test(lookahead)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Direct runWorkflow(..., { parentRunId }) call found in a workflow file — use ctx.delegateTo / ctx.delegateToAll so the kernel owns parentRunId stamping, archetype derivation, pre-emit pending, and pristine-input persistence (Contracts 1+2+3).\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});

test("no direct ensureDaemonsAndEnqueue(..., { parentRunId }) calls inside workflow handlers — use ctx.delegateToAll", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  for (const file of WORKFLOW_FILES) {
    const rel = relative(ROOT, file);
    const raw = readFileSync(file, "utf8");
    // Strip block comments first so `/* ensureDaemonsAndEnqueue(...) */`
    // doesn't false-positive as a live call site (#17).
    const src = stripCommentsPreserveLines(raw);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("* ") || trimmed.startsWith("import ")) return;
      if (!/\bensureDaemonsAndEnqueue\s*\(/.test(line)) return;
      const lookahead = lines.slice(idx, idx + 12).join("\n");
      if (!/\bparentRunId\b/.test(lookahead)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Direct ensureDaemonsAndEnqueue(..., { parentRunId }) call found in a workflow file — use ctx.delegateToAll so the kernel owns parentRunId stamping, archetype derivation, pre-emit pending, and pristine-input persistence (Contracts 1+2+3).\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});
