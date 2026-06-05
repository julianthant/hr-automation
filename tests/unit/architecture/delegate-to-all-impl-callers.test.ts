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
  // OCR's `force-research` and `retry-page` are operator-driven entrypoints
  // invoked from HTTP route handlers, not from inside a workflow `ctx`. They
  // need the same `delegateToAllImpl` escape hatch as the orchestrator for
  // the eid-lookup fan-out: `fireAndForget: true` (their own watchChildRuns
  // drives the wait) + `deriveItemId` (stable per-record item IDs so outcome
  // patching can correlate child results back to OCR records).
  "src/workflows/ocr/force-research.ts",
  "src/workflows/ocr/retry-page.ts",
  // The `verify` OCR form spec owns all of its cross-system enrichment in
  // `OcrFormSpec.enrichRecords` (person-lookup for CRM dates + active status,
  // i9-lookup for the Section-2 signer). The orchestrator awaits the hook, but
  // the hook drives its own `watchChildRuns` wait — so it needs the same
  // escape hatch as force-research: `fireAndForget: true` + `deriveItemId` for
  // stable per-record item IDs that correlate child outcomes back to records.
  "src/services/ocr/forms/verify.ts",
  // `verify-relookup` is the verify analogue of force-research: an
  // operator-driven HTTP entrypoint that re-runs ONE background lookup
  // (person-lookup or i9-lookup) for ONE verify record from the review pane.
  // Same escape-hatch needs as force-research/verify: `fireAndForget: true` +
  // `deriveItemId` for a fresh per-invocation item id its own `watchChildRuns`
  // correlates.
  "src/workflows/ocr/verify-relookup.ts",
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
