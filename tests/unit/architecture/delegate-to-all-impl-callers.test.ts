/**
 * Contract 3 — delegateToAllImpl escape hatch guard.
 *
 * `delegateToAllImpl` exposes internal hooks used only by OCR's
 * orchestrator-level eid-lookup fan-out. Production code should normally
 * call the public `ctx.delegateToAll` API; adding a second direct consumer
 * means the hooks need to be promoted to that public options object with
 * explicit tests.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listSourceFiles, stripCommentsPreserveLines } from "../../_utils/source-scanner.js";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

const ALLOWED_CALLERS = new Set<string>([
  "src/workflows/ocr/orchestrator.ts",
  // The shared OCR fan-out pipeline (BM-1). `force-research`, `retry-page`,
  // `verify` (enrichRecords ×2), and `verify-relookup` all delegated through
  // BYTE-IDENTICAL dispatch→watch→cascade-cancel copies — those copies now live
  // here as `fanOutAndWatch`, so this is the ONE delegateToAllImpl site for the
  // operator-driven re-fan paths. It needs the same escape hatch as the
  // orchestrator: `fireAndForget: true` (its own watchChildRuns drives the wait)
  // + `deriveItemId` (stable per-record item ids so outcome patching can
  // correlate child results back to OCR records).
  "src/services/ocr/fan-out.ts",
  // `reocr-whole-pdf` is the operator-driven whole-PDF re-OCR HTTP entrypoint.
  // Its dispatch and watch are split across the 202-early-return boundary (the
  // watch runs in a detached background task and emits a terminal failed/cancelled
  // row on abort, rather than rethrowing), so it keeps its own delegateToAllImpl
  // call instead of folding into `fanOutAndWatch` (which couples dispatch+watch).
  // It uses the same escape hatch so the re-fan shares the OCR root's trace
  // prefix (`rootTracePrefix`) instead of minting fresh `pl-…` prefixes:
  // `fireAndForget: true` + `deriveItemId` for stable per-record item ids.
  "src/tracker/dashboard/ocr/reocr-whole-pdf.ts",
]);

const IGNORED_FILES = new Set<string>([
  // Definition plus public ctx.delegateToAll wrapper internals.
  "src/core/delegate.ts",
]);

test("delegateToAllImpl direct production callers stay limited to OCR orchestrator", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  const callPattern = /\bdelegateToAllImpl(?:\s*<[^;\n]*?>)?\s*\(/;

  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = relative(ROOT, file);
    if (IGNORED_FILES.has(rel) || ALLOWED_CALLERS.has(rel)) continue;

    const src = stripCommentsPreserveLines(readFileSync(file, "utf8"));
    const lines = src.split("\n");

    lines.forEach((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("import ")) return;
      if (!callPattern.test(line)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `delegateToAllImpl is an OCR-orchestrator-only escape hatch. New production callers should use ctx.delegateToAll, or promote the internal hooks to the public options object with explicit tests.\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});
