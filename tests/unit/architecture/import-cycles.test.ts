import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

/**
 * Import-cycle ratchet guard.
 *
 * Builds the RUNTIME import graph of `src/` (eager `import ... from` /
 * `export ... from` edges only — `import type` / `export type` statements are
 * erased at compile time and dynamic `import()` is lazy, the repo's sanctioned
 * cycle-breaking device, so neither creates a module-initialization cycle) and
 * computes its strongly connected components. Every cycle group found must be
 * an EXACT match of an entry in ALLOWED_CYCLES below, each with a one-line
 * justification. A new cycle — or a new member joining an existing cycle —
 * fails this guard immediately; shrink or break cycles, never grow them.
 *
 * The 2026-07-16 leaf split (`tracker/jsonl-core.ts` + `tracker/log-sink.ts`)
 * broke the logger↔tracker cycles for good. These must NEVER be allowlisted:
 *   - utils/log.ts ↔ tracker (jsonl barrel → jsonl-cleanup → config → settings/store → log)
 *   - utils/log.ts → session-events → state/runtime → state/apply / jsonl-io → log
 *   - tracker/jsonl-io.ts ↔ tracker/find-latest-entry.ts
 * FORBIDDEN_IN_CYCLES pins those files out of every cycle group explicitly.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function rel(path: string): string {
  return normalize(relative(ROOT, path));
}

function resolveRelativeImport(fromFile: string, spec: string): string | null {
  const withoutJs = spec.replace(/\.js$/, "");
  const base = spec.startsWith("@/")
    ? resolve(SRC, "dashboard", withoutJs.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(fromFile), withoutJs)
      : null;
  if (!base) return null;
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * Runtime import specifiers of a source file. Matches static `import`/`export
 * ... from` statements plus bare side-effect imports; skips statements whose
 * whole clause is type-only (`import type ...` / `export type ...`).
 */
function runtimeImportSpecs(source: string): string[] {
  const specs: string[] = [];
  const fromRegex =
    /(?:import|export)\s+(type\s+)?[\w*{}\s,$-]*?\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(fromRegex)) {
    if (match[1]) continue; // `import type` / `export type` — compile-time only
    specs.push(match[2]);
  }
  const sideEffectRegex = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(sideEffectRegex)) {
    specs.push(match[1]);
  }
  return specs;
}

function buildRuntimeGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const importer = rel(file);
    const targets = new Set<string>();
    for (const spec of runtimeImportSpecs(readFileSync(file, "utf8"))) {
      const target = resolveRelativeImport(file, spec);
      if (!target) continue;
      const imported = rel(target);
      if (imported !== importer) targets.add(imported);
    }
    graph.set(importer, [...targets]);
  }
  return graph;
}

/** Tarjan strongly-connected components; returns only groups of ≥2 files. */
function findCycleGroups(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group.sort());
    }
  }

  for (const v of graph.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }
  return groups;
}

function groupKey(files: string[]): string {
  return [...files].sort().join(" | ");
}

/**
 * Ratchet allowlist — every entry is an EXISTING cycle this pass did not break,
 * with a one-line justification. Entries must match a found cycle group
 * exactly; a stale entry (cycle broken later) must be removed.
 */
const ALLOWED_CYCLES: Array<{ files: string[]; reason: string }> = [
  {
    // Kernel runtime family: workflow/pool/ctx/delegate are mutually recursive
    // by design (delegation re-enters the runner; pools wrap the runner that
    // constructs the ctx that exposes delegation). Breaking it needs a kernel
    // interface split (a future milestone), not a leaf extraction.
    files: [
      "src/core/daemon/client.ts",
      "src/core/delegate.ts",
      "src/core/kernel/batch-helpers.ts",
      "src/core/kernel/batch-lifecycle.ts",
      "src/core/kernel/ctx.ts",
      "src/core/kernel/handler-runner.ts",
      "src/core/kernel/pool-core.ts",
      "src/core/kernel/pool.ts",
      "src/core/kernel/run-one-item.ts",
      "src/core/kernel/run-workflow.ts",
      "src/core/kernel/shared-context-pool.ts",
      "src/core/kernel/workflow.ts",
      "src/core/pending-data.ts",
    ],
    reason:
      "core/kernel execution family — delegation/pool/ctx re-entrancy; needs a kernel interface split, out of scope for the 2026-07-16 tracker leaf pass",
  },
];

/** Files that must never participate in ANY cycle (the 2026-07-16 log/tracker leaf split). */
const FORBIDDEN_IN_CYCLES = [
  "src/utils/log.ts",
  "src/config.ts",
  "src/tracker/settings/store.ts",
  "src/tracker/jsonl.ts",
  "src/tracker/jsonl-io.ts",
  "src/tracker/jsonl-core.ts",
  "src/tracker/jsonl-cleanup.ts",
  "src/tracker/find-latest-entry.ts",
  "src/tracker/session-events.ts",
  "src/tracker/state/runtime.ts",
  "src/tracker/state/apply.ts",
  "src/tracker/state/rebuild.ts",
];

describe("runtime import cycles (ratchet)", () => {
  const graph = buildRuntimeGraph();
  const groups = findCycleGroups(graph);

  it("includes dashboard @/ alias edges in the runtime graph", () => {
    assert.ok(
      graph.get("src/dashboard/components/shared/RetryButton.tsx")
        ?.includes("src/dashboard/lib/workflow-action-utils.ts"),
      "@/lib/workflow-action-utils must resolve through tsconfig's src/dashboard alias",
    );
  });

  it("resolves a same-named module file before a sibling directory", () => {
    assert.ok(
      graph.get("src/cli.ts")
        ?.includes("src/tracker/dashboard.ts"),
      "./tracker/dashboard.js must resolve to dashboard.ts, not the dashboard directory",
    );
    assert.ok(
      graph.get("src/control/ops/queue.ts")
        ?.includes("src/tracker/state/queries.ts"),
      "../../tracker/state/queries.js must resolve to queries.ts, not the queries directory",
    );
  });

  it("keeps utils/log + tracker persistence out of every cycle", () => {
    const offending: string[] = [];
    for (const group of groups) {
      for (const file of group) {
        if (FORBIDDEN_IN_CYCLES.includes(file)) {
          offending.push(`${file} participates in cycle: ${groupKey(group)}`);
        }
      }
    }
    assert.deepEqual(offending, []);
  });

  it("only allowlisted cycle groups exist (no NEW cycles, no stale entries)", () => {
    const foundKeys = new Set(groups.map(groupKey));
    const allowedKeys = new Set(ALLOWED_CYCLES.map((e) => groupKey(e.files)));

    const newCycles = [...foundKeys].filter((k) => !allowedKeys.has(k));
    const staleEntries = [...allowedKeys].filter((k) => !foundKeys.has(k));

    assert.deepEqual(
      newCycles,
      [],
      `NEW runtime import cycle(s) detected. Break the cycle (prefer a leaf split — see ` +
        `src/tracker/jsonl-core.ts / src/utils/log-context.ts precedents) or, only if it ` +
        `cannot be broken in this pass, add an exact-match ALLOWED_CYCLES entry with a ` +
        `one-line justification.\n${newCycles.join("\n---\n")}`,
    );
    assert.deepEqual(
      staleEntries,
      [],
      `Stale ALLOWED_CYCLES entries (cycle no longer exists — remove them):\n${staleEntries.join("\n")}`,
    );
  });
});
