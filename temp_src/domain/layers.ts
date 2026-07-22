/**
 * `temp_src` layer order — the single source of truth for dependency direction.
 *
 * The invariant this table exists to express (enforced by the extended `control-layering` matrix
 * guard — `docs/rebuild/10-guard-test-architecture.md` §2: "enforce the full … direction over
 * `temp_src` (today only the `control` edge is guarded)"):
 *
 *     an import is LEGAL iff  rank(target layer) <= rank(importer layer)
 *
 * Equal ranks are never used — the order is total, so "<=" collapses to "same directory or lower".
 * The guard is not written yet (it lands with the ratchet extension); this file is its SSOT, so the
 * ordering is decided ONCE, here, with evidence, rather than re-argued per guard.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVERSION: `core` sits ABOVE `workflows` (the opposite of `src/`)
 * ---------------------------------------------------------------------------------------------
 * The old tree's order is `domain → infra/services/systems → core → control/workflows` (project
 * CLAUDE.md; restated in `docs/rebuild/10-guard-test-architecture.md`:67) — `core` BELOW workflows,
 * because `src/core` is the kernel that workflows call into and `WORKFLOW_LOADERS` only ever held
 * lazy `() => import(...)` thunks, never workflow values.
 *
 * In `temp_src` that flips. The line that settles it is `docs/rebuild/02-workflow-model.md`:161-165:
 *
 *     // temp_src/core/workflow-registry.ts      (server only — the WORKFLOW_LOADERS successor)
 *     export const SERVER_REGISTRY: Record<WorkflowId, {
 *       descriptor: AnyDescriptor;
 *       loadStores: () => Promise<void>;
 *     }> = { ... };
 *
 * The successor registry holds the **descriptor value** (not just a loader thunk), so
 * `core/workflow-registry.ts` must import `workflows/<id>/descriptor.ts` at module scope. Hence
 * rank(workflows) < rank(core). This is safe rather than circular because doc 02 §1.2 splits every
 * workflow in two: `descriptor.ts` is client-safe and value-imports "only zod, and domain"
 * (`docs/rebuild/02-workflow-model.md`:52 and :139), while `index.ts` is the server barrel that
 * pairs it with its stores' impls (:140). Nothing under `workflows/` reaches up into `core`.
 *
 * Corollary: `core` is no longer "the kernel everything calls". The kernel machinery that workflows
 * used to call is now split — task/store primitives live in `base` (rank 2) and the run loop lives
 * in `exec` (rank 7). `core` is specifically the **registry/wiring** layer.
 *
 * ---------------------------------------------------------------------------------------------
 * KNOWN DOC CONFLICT — flagged, deliberately NOT silently worked around
 * ---------------------------------------------------------------------------------------------
 * `docs/rebuild/02-workflow-model.md`:151-158 places the client-safe `DESCRIPTORS` barrel at
 * `temp_src/domain/workflow/index.ts` and shows it importing `../../workflows/<id>/descriptor.js`.
 * That edge is `domain` (rank 1) → `workflows` (rank 4): illegal under ANY total order that also
 * lets `descriptor.ts` import domain contracts (which doc 02 §1.4 rule 6 requires). It is a
 * directory-level cycle `domain ↔ workflows`; the file-level `import-cycles` SCC guard would not
 * catch it, the layer matrix would.
 *
 * This file does NOT resolve it — the doc-02 owner must. Recommended resolution: move the
 * `DESCRIPTORS` barrel next to `SERVER_REGISTRY` in `core/` (it is a registry, not vocabulary) and
 * keep its bundle-safety as a separate guarded property, since the dashboard (rank 9) imports it
 * directly and outranks `core` either way. Until that is settled, the layer guard must NOT be given
 * an allowlist entry for the edge — the fix belongs in the tree, not the allowlist.
 */

/** A top-level directory of `temp_src`. */
export type LayerName = keyof typeof LAYERS;

/**
 * The closed, ordered layer table. Lower rank = deeper in the dependency graph.
 *
 * `dashboard` is declared ahead of its directory: it is excluded from the backend tsconfig and the
 * back-end eslint block exactly like `src/dashboard`, and it has no content yet. Consumers of this
 * table must treat a declared layer whose directory is absent as "not created yet", never as an
 * error — that is what keeps the carve-outs honest when the folder does land.
 */
export const LAYERS = {
  events: {
    rank: 0,
    reason:
      "Zero-import wire/at-rest leaf (doc 03:62). Rank 0 makes 'imports nothing' a matrix fact.",
  },
  domain: {
    rank: 1,
    reason:
      "Bundle-safe vocabulary: contracts, clock, config, secrets, fields, ledger (docs 01 §3.1, 11, 06 §1, 09).",
  },
  base: {
    rank: 2,
    reason:
      "Impl-side primitives — defineTask/defineStore/errors/session/decorate; may import Playwright types (doc 01:95).",
  },
  stores: {
    rank: 3,
    reason:
      "Per-system + service task impls bound via defineTask; consume base + domain contracts (doc 01 §3.1/§3.4).",
  },
  workflows: {
    rank: 4,
    reason:
      "descriptor.ts (domain-only) + server barrel pairing the descriptor with its stores' impls (doc 02 §1.2).",
  },
  tracker: {
    rank: 5,
    reason:
      "Owns the typed span/note emit path + JSONL/SQLite writers; producers call INTO it, so it stays below core/exec (doc 10 §2 tracker-row-emission).",
  },
  core: {
    rank: 6,
    reason:
      "SERVER_REGISTRY holds each workflow's descriptor value + lazy store loaders — the inversion argued above (doc 02:161).",
  },
  exec: {
    rank: 7,
    reason:
      "Workflow-agnostic executor, lanes, session pool and page leases; claims runs and drives the run state machine (doc 05 §2/§3).",
  },
  server: {
    rank: 8,
    reason:
      "HTTP/SSE edge — serves tracker projections, enqueues runs, controls executors (doc 03 §2.2).",
  },
  dashboard: {
    rank: 9,
    reason:
      "Browser SPA. Directory not created yet; excluded from the backend tsconfig and the back-end eslint block, mirroring src/dashboard.",
  },
} as const satisfies Record<string, { readonly rank: number; readonly reason: string }>;

/** Layer names ordered bottom-up — deepest dependency first. */
export const LAYER_ORDER = [
  "events",
  "domain",
  "base",
  "stores",
  "workflows",
  "tracker",
  "core",
  "exec",
  "server",
  "dashboard",
] as const satisfies readonly LayerName[];

/**
 * Rank lookup. Fails loud on an unknown directory rather than defaulting: an unranked top-level
 * directory means the tree grew a layer nobody decided the order for, and a silent default would
 * let it import anything.
 */
export function layerRank(layer: string): number {
  if (!(layer in LAYERS)) {
    throw new Error(
      `Unknown temp_src layer "${layer}" — add it to LAYERS in temp_src/domain/layers.ts with a rank and a reason before importing from it.`,
    );
  }
  return LAYERS[layer as LayerName].rank;
}

/** `true` iff `importer` may import from `target` under the layer invariant. */
export function mayImport(importer: string, target: string): boolean {
  return layerRank(target) <= layerRank(importer);
}
