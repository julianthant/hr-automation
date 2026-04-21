# Step-Cache — Skip Expensive Read-Only Work on Retry

Companion to `src/core/idempotency.ts`. Pattern-twin: idempotency prevents
double-writes on retry; step-cache prevents double-reads.

Source: `src/core/step-cache.ts`.

## When to use

A step is a good cache candidate when ALL of:

- It's **read-only** (extract, scrape, search) — not submit/save/write.
- It's **deterministic given the inputs** (same docId + same day → same data).
- It's **expensive** — caching saves meaningful retry time on a late-step
  failure.
- Its output **fits in JSON** (no Playwright pages, no streams, no buffers,
  no `BigInt`, no circular refs — `stepCacheSet` will throw).

## What's opted in today

| Workflow | Step | Cache key | Reason |
|----------|------|-----------|--------|
| onboarding  | `extraction`       | `onboarding-<email>`    | CRM re-scrape (`extractRawFields` + retries) is ~2 min; a late failure in `pdf-download` or later shouldn't re-scrape. |
| separations | `kuali-extraction` | `separations-<docId>`   | Kuali Action-List open + document click + `extractSeparationData` is ~8s; same-day reruns reuse it. |

Everything else in those workflows (and every step in every other workflow)
is **not** opted in.

## What should NEVER be cached

- `ucpath-transaction` (onboarding, separations) — mutating submit.
- `kuali-finalization` (separations) — writes back to Kuali.
- `kronos-search`, any UKG step — depends on current UKG state.
- Any auth / Duo step — freshness matters.
- Any step whose output holds a `Page`, `Locator`, stream, or buffer.

## How to opt a step in

```ts
import { stepCacheGet, stepCacheSet } from "../../core/step-cache.js";

await ctx.step("my-step", async () => {
  const cached = stepCacheGet<MyOutput>("my-workflow", itemId, "my-step");
  if (cached) {
    log.success("[MyStep] Cached — reusing");
    return cached;
  }

  const result = await doExpensiveReadOnlyWork();

  // Cache write is best-effort: a disk-full / perm error must NOT fail
  // the step — the underlying work already succeeded.
  try {
    stepCacheSet("my-workflow", itemId, "my-step", result);
  } catch (e) {
    log.warn(`Step cache write failed (continuing): ${errorMessage(e)}`);
  }

  return result;
});
```

`stepCacheGet` never throws on a miss / corrupt JSON / filesystem error —
it just returns `null`, and the step falls through to the real work.

`stepCacheSet` **does** throw on a non-serializable value (`BigInt`,
circular ref, function) or an unsafe path segment (path separator, `..`,
NUL, control char in `workflow` / `itemId` / `stepName`). That's why the
call site wraps it in try/catch.

## Storage + TTL

- Location: `.tracker/step-cache/<workflow>-<itemId>/<stepName>.json`
  (constant `DEFAULT_STEP_CACHE_DIR = ".tracker/step-cache"`).
- One JSON file per step, atomic-written (temp file + `rename`), so a
  crash mid-write leaves the previous value intact.
- **Read TTL: 2 hours by default.** Override per call with
  `stepCacheGet<T>(wf, id, step, { withinHours: N })`. Pass `withinHours: 0`
  to disable the TTL check entirely (returns any non-corrupt entry
  regardless of age).
- **On-disk lifetime: until `pruneOldStepCache` runs.** That helper walks
  the tree and deletes `.json` files whose mtime is older than
  `maxAgeHours` (default **168 h / 7 days**), then removes empty item
  directories. It's not called automatically — invoke it from a cleanup
  script if you want bounded disk use.

Record shape on disk (`StepCacheRecord<T>`):

```json
{
  "workflow": "separations",
  "itemId": "3917",
  "stepName": "kuali-extraction",
  "ts": "2026-04-21T17:30:00.000Z",
  "value": { /* your typed payload */ }
}
```

`.tracker/` is gitignored, so cached PII (names, SSN, DOB in onboarding
extraction) never enters the repo — same trust boundary as
`~/Downloads/onboarding/` PDFs.

## Observability

On a cache hit, `stepCacheGet` calls `emitCacheHit(itemId, itemId, stepName, opts?.dir)`
from `src/tracker/session-events.ts`, which writes a `cache_hit` entry to
the session event stream (`workflowInstance`, `currentItemId`, `step`).
The emit is wrapped in try/catch — an instrumentation failure never masks
the cached value.

No other events are emitted. Cache misses, writes, TTL expiries, and
corrupt-JSON reads are silent at the primitive level — add logging at the
call site (see onboarding's `log.warn("Using cached extraction data …")`)
if you want them visible.

## How to clear

Manually, by path:

```bash
# One step for one item
rm .tracker/step-cache/separations-3917/kuali-extraction.json

# All steps for one item
rm -rf .tracker/step-cache/separations-3917/

# Nuke the whole cache
rm -rf .tracker/step-cache/
```

Programmatically:

```ts
import { stepCacheClear, pruneOldStepCache } from "../../core/step-cache.js";

// One step — or omit stepName to clear the whole item dir
stepCacheClear("separations", "3917", "kuali-extraction");
stepCacheClear("separations", "3917");

// Delete all .json files older than 24h across the whole tree
pruneOldStepCache(24);
```

## History

- **2026-04-18** — Primitive shipped (`src/core/step-cache.ts`). Onboarding
  `extraction` opts in first. Full design rationale:
  `docs/superpowers/specs/2026-04-18-step-cache-design.md`.
- **2026-04-21** — Separations `kuali-extraction` opts in. This explainer
  written.
