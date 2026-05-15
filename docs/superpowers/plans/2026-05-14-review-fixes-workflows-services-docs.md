# Code Review Fixes — Workflows + Services + Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user is running this inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every correctness, performance, and simplification finding from the 2026-05-14 codebase review for `src/workflows/`, `src/services/`, `src/domain/`, plus all documentation drift (root CLAUDE.md, README.md, src/core/CLAUDE.md, src/dashboard/CLAUDE.md, etc.). Exclude the `src/config.ts:48-50` `ANNUAL_DATES` bump (intentional).

**Architecture:** Sequential per-task work on master. Correctness (real bugs, including OCR auto-accept floor and matching name-set collapse) first, then performance hot paths (OCR orchestrator + matching), then simplifications (CLI adapter dedup, OCR helper consolidation), then docs. Each task is one commit.

**Tech Stack:** TypeScript, Node 26, Zod v4, Playwright (via system drivers), node:sqlite (via tracker), Gemini OCR, ExcelJS roster loading.

**Verification per task:**
```bash
npm run typecheck && npm run test && npm run test:architecture
```

If the task touches OCR/matching, also run `npm run test -- tests/unit/services/ocr` or equivalent.

---

## Phase A — Services correctness (critical bugs)

### Task A1: Emergency contact OCR auto-accept score floor

**File:** `src/services/ocr/forms/emergency-contact.ts:137`

- [ ] **Step 1:** Read `ROSTER_AUTO_ACCEPT` constant near line 95-96. Add the score guard alongside the existing single-candidate check:

```ts
// Before
if (result.candidates.length === 1 && result.candidates[0].eid) {
  return { matchState: "matched", eid: result.candidates[0].eid, ... };
}

// After
const top = result.candidates[0];
if (
  result.candidates.length === 1 &&
  top.eid &&
  top.score >= ROSTER_AUTO_ACCEPT
) {
  return { matchState: "matched", eid: top.eid, ... };
}
```

Below threshold should fall through to the same `lookup-pending` / disambiguation path used in the oath spec.

- [ ] **Step 2:** Add a unit test in `tests/unit/services/ocr/forms/emergency-contact.test.ts` (or extend existing) asserting that a sole candidate with score 0.5 does NOT auto-accept.
- [ ] **Step 3:** Run `npm run test -- tests/unit/services/ocr`.
- [ ] **Step 4:** Commit: `fix(services/ocr): require ROSTER_AUTO_ACCEPT score for single-candidate emergency-contact match`.

### Task A2: Token-set match duplicate-token collapse

**File:** `src/services/matching/match.ts:39-48`

- [ ] **Step 1:** The token-set match uses `Set` for both sides, so `"John John"` (two identical tokens) collapses to `{john}` and matches any `"John X"` at score 0.9. Fix by using raw token arrays for the intersection denominator, or by adding a minimum-distinct-token-count guard:

```ts
// Before
const aSet = new Set(aTokens);
const bSet = new Set(bTokens);
const inter = [...aSet].filter((t) => bSet.has(t));
const ratio = inter.length / Math.min(aSet.size, bSet.size);

// After — guard on distinct tokens AND raw array lengths
if (aTokens.length < 2 || bTokens.length < 2) {
  // single-token names don't qualify for token-set match
  return null;  // or whatever the no-match return shape is
}
const aSet = new Set(aTokens);
const bSet = new Set(bTokens);
const inter = [...aSet].filter((t) => bSet.has(t));
const ratio = inter.length / Math.min(aSet.size, bSet.size);
```

- [ ] **Step 2:** Add a unit test asserting `"John John"` does NOT match `"John Smith"` at the auto-accept threshold.
- [ ] **Step 3:** Run `npm run test -- tests/unit/services/matching`.
- [ ] **Step 4:** Commit: `fix(services/matching): guard token-set match against duplicate-token collapse`.

### Task A3: OCR rotation quota-exhausted day-rollover

**File:** `src/services/ocr/rotation.ts:79-85`

- [ ] **Step 1:** Read `getEntry`. The current logic only clears `quota-exhausted` state when `e.state.untilMs <= Date.now()`, but a new UTC day can have `untilMs` still slightly in the future. Fix by clearing on the day-rollover signal regardless of `untilMs`:

```ts
// Before
if (e.dailyEpochDay !== today) {
  e.dailyEpochDay = today;
  e.dailyCount = 0;
  if (e.state.kind === "quota-exhausted" && e.state.untilMs <= Date.now()) {
    e.state = { kind: "ok" };
  }
}

// After
if (e.dailyEpochDay !== today) {
  e.dailyEpochDay = today;
  e.dailyCount = 0;
  if (e.state.kind === "quota-exhausted") {
    e.state = { kind: "ok" };  // new day clears quota regardless of untilMs
  }
}
```

- [ ] **Step 2:** Add a unit test that fakes a midnight rollover with `untilMs` slightly in the future and asserts the key is freed.
- [ ] **Step 3:** Run `npm run test -- tests/unit/services/ocr`.
- [ ] **Step 4:** Commit: `fix(services/ocr): quota-exhausted state clears on new UTC day regardless of untilMs`.

### Task A4: Unify three getGeminiKeys copies + fix cap mismatch

**Files:** `src/services/ocr/lookup-suggestions.ts:136-150`, `src/services/ocr/disambiguate.ts:72-86`, `src/services/ocr/index.ts:47-61`, `src/services/ocr/per-page-pool.ts:32` (existing `readKeys`)

- [ ] **Step 1:** Create `src/services/ocr/env-keys.ts`:

```ts
import { log } from "../../utils/log.js";

const KEY_BASE = "GEMINI_API_KEY";
const MAX_KEY_INDEX = 8;

export function readGeminiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= MAX_KEY_INDEX; i++) {
    const envName = i === 1 ? KEY_BASE : `${KEY_BASE}${i}`;
    const v = process.env[envName]?.trim();
    if (v) keys.push(v);
  }
  if (keys.length === 0) log.warn("No GEMINI_API_KEY* env vars set");
  return keys;
}
```

- [ ] **Step 2:** Replace each `getGeminiKeys()` in disambiguate.ts / lookup-suggestions.ts / index.ts with `readGeminiKeys()`. Replace `per-page-pool.ts:readKeys("GEMINI_API_KEY")` with `readGeminiKeys()` too.
- [ ] **Step 3:** Verify keys 7 and 8 are now picked up by disambiguation + lookup-suggestions (previously capped at 6).
- [ ] **Step 4:** Run `npm run typecheck && npm run test -- tests/unit/services/ocr`.
- [ ] **Step 5:** Commit: `fix(services/ocr): unify getGeminiKeys and raise key cap to 8 (matches pool builder)`.

### Task A5: Capture server.ts log finalize errors

**File:** `src/services/capture/server.ts:526-546`

- [ ] **Step 1:** Add `log.warn(...)` inside the background IIFE's catch before `setState("discarded")`. Currently failures are completely silent.

```ts
void (async () => {
  try {
    await bundlePhotosToPdf(...);
    setState(sessionId, "completed");
  } catch (err) {
    log.warn("capture finalize bundle failed", { sessionId, error: String(err) });
    setState(sessionId, "discarded");
  }
})();
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(services/capture): log finalize bundle failures before discarding session`.

---

## Phase B — Workflows correctness

### Task B1: onboarding wrap CRM ops in ctx.step

**File:** `src/workflows/onboarding/workflow.ts:149-175`

- [ ] **Step 1:** The 4 `ctx.retry(...)` calls (`searchByEmail`, `selectLatestResult`, `extractRecordPageFields`, `navigateToSection`) run bare in the handler — not inside any `ctx.step`. Wrap them in a named step:

```ts
ctx.markStep("crm-auth");
await ctx.step("crm-search", async () => {
  await ctx.retry(searchByEmail);
  await ctx.retry(selectLatestResult);
  await ctx.retry(extractRecordPageFields);
  await ctx.retry(navigateToSection);
});
```

- [ ] **Step 2:** Add `"crm-search"` to `onboardingSteps` const tuple at the top of the file.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `fix(onboarding): wrap CRM search/navigation in ctx.step for observability`.

### Task B2: Remove `ctx.skipStep?.` optional chain

**File:** `src/workflows/eid-lookup/workflow.ts:401`

- [ ] **Step 1:** Decide based on the kernel's `Ctx` type definition in `src/core/kernel/types.ts`:
  - If `skipStep` is non-optional on `Ctx`: remove the `?.` to call unconditionally.
  - If `skipStep` is optional: every other caller (separations, emergency-contact, oath-signature) is at risk. The correct fix is to make `skipStep` non-optional in the type.

Read `types.ts`, pick the correct fix, and apply.

- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `fix(eid-lookup): remove optional chain on ctx.skipStep`.

### Task B3: oath-upload wait-signatures operator visibility

**File:** `src/workflows/oath-upload/handler.ts:144`

- [ ] **Step 1:** Before entering `watchChildRuns`, emit context so the operator knows what to retry on failure:

```ts
const signerIds = signerDetails.map((s) => s.runId);
log.step("wait-signatures", { itemCount: signerIds.length, signerIds });
ctx.updateData({ status: "waiting-signatures", signerDetails });

await watchChildRuns({
  // ... existing options ...
  isTerminal: (e) => e.status === "done",  // unchanged
});
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(oath-upload): emit wait-signatures context so operator knows what to retry`.

### Task B4: oath-upload readPriorOcrApproval cross-day

**File:** `src/workflows/oath-upload/handler.ts:189-219`

- [ ] **Step 1:** Read the function. Currently `readPriorOcrApproval` scans only `ocr-${dateLocal()}.jsonl`. Extend to scan the last 7 days (matching the project's standard recovery window):

```ts
const lookbackDays = 7;
const today = new Date();
for (let i = 0; i < lookbackDays; i++) {
  const d = new Date(today);
  d.setDate(today.getDate() - i);
  const file = join(dir, `ocr-${dateLocal(d)}.jsonl`);
  if (!existsSync(file)) continue;
  // ... existing scan logic ...
  if (found) return found;
}
return null;
```

- [ ] **Step 2:** Add a unit test that places a prior approval in yesterday's JSONL and confirms it's found.
- [ ] **Step 3:** Run `npm run test -- tests/unit/workflows`.
- [ ] **Step 4:** Commit: `fix(oath-upload): scan last 7 days for prior OCR approval on restart`.

### Task B5: Workflow process.exit → throw

**Files:** `src/workflows/work-study/workflow.ts:119`, `src/workflows/oath-signature/workflow.ts:142`, `src/workflows/oath-upload/workflow.ts:68`

- [ ] **Step 1:** Replace each `process.exit(1)` with `throw err` (re-throw the caught error). The CLI adapter or `src/cli.ts` is the proper place to translate to an exit code; killing the daemon mid-flight from a composable in-process function is wrong.
- [ ] **Step 2:** Verify the CLI adapters set `process.exitCode = 1` on caught errors (read `runXxxCli` for each).
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `fix(workflows): throw instead of process.exit in composable in-process paths`.

### Task B6: separations chosenDateSource label fix

**File:** `src/workflows/separations/workflow.ts:382-388`

- [ ] **Step 1:** Read the bypass path that produces `chosenDateSource = "Kuali (no change)"`. When the user has prefilled `lastDayWorked` to differ from `kualiData.lastDayWorked`, the label is misleading. Detect this and emit `"Kuali (operator override)"` or similar:

```ts
const prefilledMatchesKuali = ctx.data.lastDayWorked === kualiData.lastDayWorked;
const chosenDateSource = prefilledMatchesKuali
  ? "Kuali (no change)"
  : "Operator-prefilled (overrides Kuali)";
```

- [ ] **Step 2:** Commit: `fix(separations): chosenDateSource label distinguishes operator override`.

### Task B7: separations terminationType bypass-path raw form

**File:** `src/workflows/separations/workflow.ts:275-279`

- [ ] **Step 1:** Verify what `isVoluntaryTermination` actually checks. Open `src/workflows/separations/mapping.ts` (or wherever the function lives). If it handles only raw Kuali strings, the bypass fallback chain at lines 275-279 can incorrectly pass `"Vol"`/`"Invol"` display values.
- [ ] **Step 2:** Fix one of:
  - Restrict the bypass fallback chain to only `rawTerminationType` (drop the `terminationType` fallback to display values).
  - Widen `isVoluntaryTermination` to handle both raw and display strings.

Pick the option that aligns with existing semantics (probably restricting the fallback chain).

- [ ] **Step 3:** Add a unit test asserting the bypass path with only display-form `terminationType` produces the expected template.
- [ ] **Step 4:** Run `npm run test -- tests/unit/workflows`.
- [ ] **Step 5:** Commit: `fix(separations): bypass-path terminationType uses raw form only`.

### Task B8: crm-doc-download deriveItemId throws on empty

**File:** `src/workflows/crm-doc-download/workflow.ts:96-98`

- [ ] **Step 1:** Replace the empty-string fallback with a thrown error matching `resolveCrmDocDownloadSearchQuery`:

```ts
export function deriveCrmDocDownloadItemId(input: CrmDocDownloadInput): string {
  if (input.email) return input.email;
  if (input.emplId) return input.emplId;
  throw new Error("crm-doc-download requires email or emplId");
}
```

- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `fix(crm-doc-download): throw on empty itemId to avoid queue collisions`.

### Task B9: onboarding remove buildCrmDocDownloadDelegationInput dead export

**File:** `src/workflows/onboarding/workflow.ts:45-61`

- [ ] **Step 1:** `rg "buildCrmDocDownloadDelegationInput" src` — confirm zero external callers. Delete the function and its `CrmDocDownloadInput` import.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `chore(onboarding): drop unused buildCrmDocDownloadDelegationInput`.

### Task B10: emergency-contact save step body

**File:** `src/workflows/emergency-contact/workflow.ts:211-218`

- [ ] **Step 1:** Move the UCPath `Save` click out of `buildEmergencyContactPlan` (which runs in `"fill-form"`) and into the `"save"` step body using a `beforeSave` hook (mirroring the existing `beforeCommit` hook pattern). The step label should reflect where the save actually occurs.
- [ ] **Step 2:** Verify the timeline view in the dashboard now shows wall-clock time in the `"save"` step.
- [ ] **Step 3:** Run `npm run test`.
- [ ] **Step 4:** Commit: `fix(emergency-contact): actually save in the save step`.

---

## Phase C — Services performance

### Task C1: OCR orchestrator records snapshot caching + onProgress debounce

**File:** `src/workflows/ocr/orchestrator.ts:195, 921-932, 1018-1028`

- [ ] **Step 1:** Cache the stringified records on a content-hash key inside `emitSnapshot` so repeat `writeTracker` calls with identical records don't re-serialize:

```ts
let lastRecordsHash: string | null = null;
let lastRecordsString: string | null = null;
function snapshotRecords(records: OcrRecord[]): string {
  const hash = computeQuickHash(records);  // e.g., records.length + last id
  if (hash === lastRecordsHash && lastRecordsString) return lastRecordsString;
  lastRecordsHash = hash;
  lastRecordsString = JSON.stringify(records);
  return lastRecordsString;
}
```

- [ ] **Step 2:** Debounce `onProgress` callback so it batches outcomes (e.g., 250ms window) before emitting `emitSnapshot`:

```ts
let debounceTimer: NodeJS.Timeout | null = null;
const onProgress = (outcome: ChildOutcome) => {
  // ... aggregate outcome into records ...
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emitSnapshot("eid-lookup");
    debounceTimer = null;
  }, 250);
};
```

Ensure final emit fires after all children complete (flush the timer in `watchChildRuns` finally).

- [ ] **Step 3:** Run an OCR workflow end-to-end and confirm JSONL writes drop from ~25 to ~5 per run.
- [ ] **Step 4:** Commit: `perf(ocr): cache records snapshot string + debounce onProgress emissions`.

### Task C2: OCR orchestrator memoize resolveParentSubject

**File:** `src/workflows/ocr/orchestrator.ts:1159-1173`

- [ ] **Step 1:** Memoize `resolveParentSubject(parentRunId, originWorkflow)` for the lifetime of the orchestrator run. The value is immutable for a given parentRunId.

```ts
const parentSubjectCache = new Map<string, string | null>();
async function resolveParentSubjectCached(parentRunId: string, originWorkflow: string): Promise<string | null> {
  const key = `${originWorkflow}::${parentRunId}`;
  if (parentSubjectCache.has(key)) return parentSubjectCache.get(key)!;
  const val = await resolveParentSubject(parentRunId, originWorkflow);
  parentSubjectCache.set(key, val);
  return val;
}
```

Place the cache at the top of `runOcrOrchestrator` (line 113-ish) so it scopes to one orchestrator run.

- [ ] **Step 2:** Commit: `perf(ocr): memoize parent-subject lookups for orchestrator lifetime`.

### Task C3: Roster tokenization hoisted out of inner loop

**Files:** `src/services/matching/match.ts:11-17`, `src/services/ocr/forms/oath.ts:203`, `src/services/ocr/forms/emergency-contact.ts:136`

- [ ] **Step 1:** Today `matchAgainstRoster` re-tokenizes every roster row for every OCR record (N×M tokenize calls). Precompute roster tokenization once:

```ts
// In matchAgainstRoster — accept a pre-tokenized roster
type TokenizedRosterRow = RosterRow & { _nameTokens: string[]; _nameSet: Set<string> };

export function precomputeRoster(roster: RosterRow[]): TokenizedRosterRow[] {
  return roster.map((r) => ({
    ...r,
    _nameTokens: tokenize(r.name),
    _nameSet: new Set(tokenize(r.name)),
  }));
}

export function matchAgainstRoster(roster: TokenizedRosterRow[], targetName: string): MatchResult {
  // use row._nameTokens / row._nameSet directly
}
```

In the orchestrator, call `precomputeRoster(roster)` once at orchestrator init, then pass the tokenized roster to each per-record match call.

- [ ] **Step 2:** Add unit tests confirming match scores unchanged.
- [ ] **Step 3:** Run `npm run test -- tests/unit/services/matching`.
- [ ] **Step 4:** Commit: `perf(matching): tokenize roster once per orchestrator, not per record`.

### Task C4: OCR per-page-pool drop fs.stat-for-log

**File:** `src/services/ocr/per-page-pool.ts:60-128`

- [ ] **Step 1:** Remove the `await fs.stat(path)` call that runs purely to log file size. The size can be derived from `png.length` after `fs.readFile`. Saves one syscall per page-OCR call.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/services/ocr`.
- [ ] **Step 3:** Commit: `perf(ocr): drop unnecessary fs.stat in per-page-pool logging`.

### Task C5: OCR readPreviousRecords use SQLite or stream

**File:** `src/workflows/ocr/orchestrator.ts:482, 1031-1056`

- [ ] **Step 1:** Replace the `readFileSync` + JSON.parse-every-line scan with either:
  - SQLite query through `deps.stateDb` if available (probably faster).
  - Streaming JSONL reader via the new `readJsonlStream` helper from Plan 1 Task D31 — read from end backwards via `node:fs.createReadStream` with `start`/`end` offsets, parse line-by-line, stop at first match. (More complex but works without DB.)

Pick SQLite when ready, JSONL stream otherwise.

- [ ] **Step 2:** Commit: `perf(ocr): read-previous-records uses SQLite/stream instead of full sync scan`.

### Task C6: Oath-upload duplicate-check async + cache

**File:** `src/workflows/oath-upload/duplicate-check.ts:43-58`

- [ ] **Step 1:** Switch `readFileSync` to `readFile` (async). The duplicate-check fires on every PDF file selection in the modal and is currently a blocking sync read.
- [ ] **Step 2:** Cache parsed results by `(file, mtime)`. Multiple duplicate-checks against the same JSONL file in the same hour will hit cache.
- [ ] **Step 3:** Run dashboard, open oath-upload modal, select several PDFs in rapid succession. Confirm no UI hang.
- [ ] **Step 4:** Commit: `perf(oath-upload): async duplicate-check with mtime-based cache`.

### Task C7: Roster loader cache by path+mtime

**File:** `src/services/matching/roster-loader.ts:63-127`

- [ ] **Step 1:** Cache the parsed roster by `(rosterPath + mtime)`:

```ts
const rosterCache = new Map<string, { mtimeMs: number; roster: RosterRow[] }>();

export function loadRoster(path: string): RosterRow[] {
  const mtimeMs = statSync(path).mtimeMs;
  const cached = rosterCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.roster;
  const roster = parseRoster(path);  // existing ExcelJS logic
  rosterCache.set(path, { mtimeMs, roster });
  return roster;
}
```

Today every OCR run reparses the workbook with ExcelJS.

- [ ] **Step 2:** Add an explicit `__resetRosterCacheForTests` export.
- [ ] **Step 3:** Run `npm run test -- tests/unit/services/matching`.
- [ ] **Step 4:** Commit: `perf(matching): cache parsed roster by path+mtime`.

### Task C8: OCR disambiguate shared key rotation

**File:** `src/services/ocr/disambiguate.ts:110-132`

- [ ] **Step 1:** Replace the sequential per-call `for (const key of keys)` retry with the same shared key-pool rotation used by `per-page-pool.ts`. Throttled keys should cascade to next key for the next call, not retry the failed key for the same call.
- [ ] **Step 2:** Run `npm run test -- tests/unit/services/ocr`.
- [ ] **Step 3:** Commit: `perf(ocr): shared key-pool rotation in disambiguate`.

---

## Phase D — Services simplifications

### Task D1: Delete dead src/services/ocr/cache.ts

**Files:** `src/services/ocr/cache.ts`, `tests/unit/services/ocr/cache.test.ts`, `src/services/ocr/index.ts` (consumers)

- [ ] **Step 1:** `rg "from.*services/ocr/cache" src` — confirm only the test imports the module. The header comment in `services/ocr/index.ts:14-24` explicitly says "Gemini OCR results are intentionally never cached."
- [ ] **Step 2:** Delete `src/services/ocr/cache.ts` and its test file. `rg "computeCacheKey\|readCache\|writeCache\|cachePath" src` — confirm zero remaining references.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `chore(services/ocr): delete dead cache module`.

### Task D2: Delete duplicate normalizeEid

**Files:** `src/services/matching/match.ts:255-257`, `src/services/matching/index.ts:7`, callers (`lookup-suggestions.ts:3`, `roster-verify.ts:5`, `forms/emergency-contact.ts:13`)

- [ ] **Step 1:** Delete the services version of `normalizeEid` (or convert to `export { normalizeEid } from "../../domain/identity/eid.js"` for compat if needed).
- [ ] **Step 2:** Update each caller's import to point at `src/domain/identity/eid.js`.
- [ ] **Step 3:** Optionally widen the domain version's signature to `unknown` to match the services version's flexibility.
- [ ] **Step 4:** Run `npm run typecheck && npm run test`.
- [ ] **Step 5:** Commit: `refactor(services/matching): delete duplicate normalizeEid, use domain version`.

### Task D3: callGeminiJson + parseJsonLoose shared helpers

**Files:** `src/services/ocr/lookup-suggestions.ts`, `src/services/ocr/disambiguate.ts`, `src/services/ocr/per-page-pool.ts:173`, new `src/services/ocr/gemini-call.ts` and `src/services/ocr/json-loose.ts`

- [ ] **Step 1:** Create `src/services/ocr/gemini-call.ts`:

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { readGeminiKeys } from "./env-keys.js";

export type GeminiCallOptions<T> = {
  prompt: string;
  parseFn: (raw: string) => T | null;
  model?: string;
};

export async function callGeminiJson<T>(opts: GeminiCallOptions<T>): Promise<T | null> {
  const keys = readGeminiKeys();
  for (const key of keys) {
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({
        model: opts.model ?? "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" },
      });
      const res = await model.generateContent([{ text: opts.prompt }]);
      const text = res.response.text();
      const parsed = opts.parseFn(text);
      if (parsed) return parsed;
    } catch (err) {
      // 401 → break, others → continue to next key
      if (String(err).includes("401")) break;
    }
  }
  return null;
}
```

- [ ] **Step 2:** Create `src/services/ocr/json-loose.ts` with `parseJsonLoose(raw: string): unknown | null` consolidating `parseJsonLoose` (per-page-pool) and `parseJsonish` (lookup-suggestions). Keep the more capable variant (json fences stripping + `{...}` and `[...]` extraction).
- [ ] **Step 3:** Repoint disambiguate.ts and lookup-suggestions.ts to use `callGeminiJson({ prompt, parseFn: (t) => SchemaX.parse(parseJsonLoose(t)) })`.
- [ ] **Step 4:** Run `npm run typecheck && npm run test -- tests/unit/services/ocr`.
- [ ] **Step 5:** Commit: `refactor(services/ocr): shared callGeminiJson + parseJsonLoose helpers`.

### Task D4: forms shared confidence thresholds + applyDisambiguation + applyCarryForward

**Files:** `src/services/ocr/forms/oath.ts`, `src/services/ocr/forms/emergency-contact.ts`, new `src/services/ocr/forms/shared.ts`

- [ ] **Step 1:** Create `src/services/ocr/forms/shared.ts` exporting `LLM_HIGH_CONFIDENCE = 0.6` and any other shared thresholds.
- [ ] **Step 2:** Extract `applyDisambiguation(record, response, { eidPath })`:

```ts
export function applyDisambiguation<R>(
  record: R,
  response: DisambiguationResponse,
  opts: { setEid: (record: R, eid: string) => R; warningText: string },
): R {
  if (!response.employeeId) {
    return opts.setEid(record, "");  // returns to manual
  }
  if (response.confidence < LLM_HIGH_CONFIDENCE) {
    // flag low-confidence warning
  }
  return opts.setEid(record, response.employeeId);
}
```

- [ ] **Step 3:** Extract `applyCarryForward(prevRecord, newRecord, matchState)` consuming the twin merge logic.
- [ ] **Step 4:** Both `oath.ts` and `emergency-contact.ts` use the shared helpers.
- [ ] **Step 5:** Run `npm run test -- tests/unit/services/ocr`.
- [ ] **Step 6:** Commit: `refactor(services/ocr): shared form-spec helpers for disambiguation + carry-forward`.

### Task D5: Services + domain misc dedupes

- [ ] **Step 1:** `services/ocr/pipeline.ts:18-24, 30-43` — Remove dead `arraySchema` field from `runOcrPipeline` input; drop redundant `attemptedKeys: [poolKeyId]` (use `poolKeyId` directly).
- [ ] **Step 2:** `services/matching/match.ts:51-57` — Verify the swap branch is redundant after the exact-tier above (the sorted-token equality covers it). If yes, drop. If unsure, leave with a comment.
- [ ] **Step 3:** `domain/active-check-outcome.ts:43-46, 48-56, 106-110` — Inline `isByEid` typeguard at the 2 call sites; collapse `normalizeDate` + `legacyTerminationDate` into one function; convert nested ternary at line 106-110 to if/else (project convention).
- [ ] **Step 4:** `domain/identity/person-name.ts:24-42, 69-101` — Extract `titleCaseTokens(s: string)` helper; rebuild `toLastFirstSearchName` to compute canonical string once at the end.
- [ ] **Step 5:** `services/capture/server.ts:27-58` — Replace twin `mimeFromExt`/`extFromMime` switches with `MIME_BY_EXT: Record<string, string>` table + reverse via `Object.entries`.
- [ ] **Step 6:** `services/capture/server.ts:222-243 and :342-360` — Extract `persistPhoto(...)` helper for the duplicated photo-write logic in `handleUpload` and `handleReplacePhoto`.
- [ ] **Step 7:** Run `npm run typecheck && npm run test -- tests/unit/services tests/unit/domain`.
- [ ] **Step 8:** Commit: `refactor(services+domain): assorted dedupes per review (pipeline, match, active-check, person-name, capture)`.

### Task D6: Services low-priority polish

- [ ] **Step 1:** `services/ocr/per-page.ts:266-291` — Replace hand-rolled `makeLimiter` with `Promise.withResolvers()` for cleaner deferred semantics.
- [ ] **Step 2:** `services/ocr/per-page-pool.ts:316-322` — Replace hand-rolled `summarizePool` Map bucketing with `Object.groupBy(pool, (k) => k.providerId)` (Node 26).
- [ ] **Step 3:** `services/matching/roster-loader.ts:79-89` — Move header column regexes into `COLUMN_PATTERNS` table.
- [ ] **Step 4:** Run `npm run typecheck && npm run test`.
- [ ] **Step 5:** Commit: `refactor(services): low-priority polish (Promise.withResolvers, Object.groupBy, column patterns)`.

---

## Phase E — Workflows simplifications

### Task E1: Extract buildCliAdapter helper

**File:** new `src/core/cli-adapter.ts`, callers in 8 workflows

- [ ] **Step 1:** Create `src/core/cli-adapter.ts`:

```ts
import type { WorkflowConfig } from "./types.js";
import { trackEvent } from "../tracker/jsonl.js";
import { operatorSubjectData } from "../domain/operator-subject.js";

export type CliAdapterOptions<TInput> = {
  workflow: WorkflowConfig<TInput, unknown>;
  extraData?: (input: TInput) => Record<string, unknown>;
};

export async function ensureDaemonsAndEnqueueWithPendingEmit<TInput>(
  items: TInput[],
  opts: CliAdapterOptions<TInput>,
  cliFlags: { newDaemon: boolean; parallel?: number },
): Promise<void> {
  const { ensureDaemonsAndEnqueue } = await import("../daemon/client.js");
  return ensureDaemonsAndEnqueue(items, {
    workflow: opts.workflow,
    onPreEmitPending: (item, runId) => {
      const subject = opts.workflow.config.operatorSubject?.(item);
      const extra = opts.extraData?.(item) ?? {};
      trackEvent({
        workflow: opts.workflow.config.name,
        timestamp: new Date().toISOString(),
        id: opts.workflow.config.getId?.(item) ?? "",
        runId,
        status: "pending",
        data: { ...extra, ...operatorSubjectData(subject) },
      });
    },
    ...cliFlags,
  });
}
```

- [ ] **Step 2:** Repoint 8 `runXxxCli` adapters (`work-study`, `separations/cli`, `oath-signature`, `eid-lookup`, `active-check`, `onboarding`, `emergency-contact` ×2, `old-kronos-reports/parallel`) to use the helper. Each adapter shrinks to ~5 lines.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Spawn a daemon for one workflow and confirm enqueue behavior unchanged.
- [ ] **Step 5:** Commit: `refactor(core+workflows): shared buildCliAdapter helper collapses ~200 lines of duplication`.

### Task E2: buildParentSubjectData helper

**File:** new `src/domain/queue-title.ts` (or extend if exists), callers `src/workflows/eid-lookup/workflow.ts:455-482`, `src/workflows/oath-signature/workflow.ts:154-180`

- [ ] **Step 1:** Extract:

```ts
export function buildParentSubjectData<T>(
  workflow: WorkflowConfig<T, unknown>,
  item: T,
): { subject: string | undefined; parentSubject: string | undefined; queueFields: Record<string, unknown> } {
  const subject = workflow.config.operatorSubject?.(item);
  const parentSubject = (item as any).parentSubject as string | undefined;
  const queueFields = parentSubject ? rootQueueTitleData(parentSubject) : {};
  return { subject, parentSubject, queueFields };
}
```

- [ ] **Step 2:** Both `eidLookupPreEmitPending` and `oathSignaturePreEmitPending` reduce to a ~10-line call.
- [ ] **Step 3:** Commit: `refactor(domain): buildParentSubjectData helper`.

### Task E3: ctx.captureAndStamp method

**Files:** `src/core/kernel/ctx.ts`, `src/workflows/active-check/workflow.ts:24-34`, `src/workflows/eid-lookup/workflow.ts:137-158`

- [ ] **Step 1:** Add a `captureAndStamp({ label, dataKey })` method to `Ctx`:

```ts
ctx.captureAndStamp = async ({ label, dataKey }) => {
  const cap = await ctx.screenshot({ label });
  const basename = cap.files?.[0]?.path.split("/").pop();
  if (dataKey && basename) ctx.updateData({ [dataKey]: basename });
  return cap;
};
```

- [ ] **Step 2:** Replace the duplicated `captureAndStampScreenshot` helpers in both workflows.
- [ ] **Step 3:** Commit: `refactor(core+workflows): ctx.captureAndStamp method`.

### Task E4: separations resolveJobSummaryResult + logSettledRejection

**File:** `src/workflows/separations/workflow.ts:104-109, 316-379, 347-375`

- [ ] **Step 1:** Either inline the 4-line `resolveJobSummaryResult` helper or generalize as `unwrapSettled<T>(r: PromiseSettledResult<T>): T | null` in `src/utils/errors.ts`. Same shape recurs 4× more in this file.
- [ ] **Step 2:** Extract `logSettledRejection(label: string, result: PromiseSettledResult<unknown>): void` consuming the `classifyPlaywrightError` + log.error/log.debug block. Replace each of the 4 rejection-classifier branches at lines 316-379.
- [ ] **Step 3:** Drop the `export` on `resolveJobSummaryResult` if it has no external callers.
- [ ] **Step 4:** Run `npm run typecheck && npm run test`.
- [ ] **Step 5:** Commit: `refactor(separations): unwrapSettled + logSettledRejection helpers cut 60-line classifier block`.

### Task E5: onboarding maskSsn → domain

**File:** `src/workflows/onboarding/workflow.ts:38-43` → `src/domain/identity/ssn.ts`

- [ ] **Step 1:** Move `maskSsn(s: string): string` into `src/domain/identity/` (new file `ssn.ts`). Future I-9 / audit code will want it.
- [ ] **Step 2:** Commit: `refactor(domain): move maskSsn to domain/identity`.

### Task E6: eid-lookup dedupeNames → domain

**File:** `src/workflows/eid-lookup/workflow.ts:420-432, 439-441` → `src/domain/identity/person-name.ts`

- [ ] **Step 1:** Move `dedupeNames` and `prepareNames` into `src/domain/identity/person-name.ts`. The `log.warn` side effect becomes a callback parameter if needed by callers.
- [ ] **Step 2:** Commit: `refactor(domain): move dedupeNames/prepareNames to domain/identity/person-name`.

### Task E7: oath-upload readPriorOcrApproval → tracker

**File:** `src/workflows/oath-upload/handler.ts:189-219` → `src/tracker/jsonl.ts` or `src/tracker/dashboard-ops.ts`

- [ ] **Step 1:** After Task B4 lands the multi-day scan, move the function into `src/tracker/jsonl.ts` (alongside `findLatestEntryData`). Generalize as `findLatestEntryForPredicate(workflow, predicate, opts)`.
- [ ] **Step 2:** Commit: `refactor(tracker): findLatestEntryForPredicate generalizes readPriorOcrApproval`.

### Task E8: old-kronos-reports loadBatchFile → utils

**File:** `src/workflows/old-kronos-reports/parallel.ts:35-57` → `src/utils/batch-yaml.ts` or via Zod

- [ ] **Step 1:** Move the YAML-array-of-strings loader with numeric-string validation into `src/utils/batch-yaml.ts`. The `src/workflows/emergency-contact/schema.ts::loadBatch` is the existing precedent — align with it.
- [ ] **Step 2:** Commit: `refactor(utils): shared batch-yaml loader`.

### Task E9: Workflow schema imports + local schemas

**Files:** `src/workflows/onboarding/workflow.ts:30,33-35`, `src/workflows/old-kronos-reports/schema.ts:1`

- [ ] **Step 1:** Move `OnboardingInputSchema` from `workflow.ts:33-35` into `src/workflows/onboarding/schema.ts` alongside `EmployeeData`.
- [ ] **Step 2:** Change `src/workflows/old-kronos-reports/schema.ts:1` from `import { z } from "zod"` to `import { z } from "zod/v4"` to align with every other workflow.
- [ ] **Step 3:** Run `npm run typecheck`.
- [ ] **Step 4:** Commit: `chore(workflows): co-locate onboarding schema; zod/v4 import in old-kronos-reports`.

### Task E10: Workflow process.exit + CLI entry helper

**File:** new `src/core/cli-entry.ts`, callers across CLI adapters

- [ ] **Step 1:** Extract a `runCliEntry<TInput>(adapter: () => Promise<void>)` helper that owns the try/catch + `process.exitCode = 1` dance. 8 files currently set exit codes inline.
- [ ] **Step 2:** Repoint CLI adapters. (Note: Task B5 from Phase B already removed `process.exit(1)` from in-process paths; this task standardizes the CLI-boundary exit handling.)
- [ ] **Step 3:** Commit: `refactor(core): shared runCliEntry helper for CLI exit-code handling`.

### Task E11: Workflows low-priority polish

- [ ] **Step 1:** `oath-signature/workflow.ts:14` + `emergency-contact/workflow.ts:37` — Pick one style (always extract `const WORKFLOW = "..."` or always inline) and apply consistently. Match the majority style.
- [ ] **Step 2:** `eid-lookup/workflow.ts:443-445` — Move `deriveEidLookupItemId` above the workflow that references it.
- [ ] **Step 3:** `eid-lookup/workflow.ts:276-304` — Drop `export` on `resolveActiveStatusResultsForEidLookup` if no external callers.
- [ ] **Step 4:** `oath-upload/handler.ts:21` — Move `SEVEN_DAYS_MS` to `src/utils/durations.ts`.
- [ ] **Step 5:** `onboarding/workflow.ts:176-194` — Move inline `buildDetailFieldsPayload` to `extract.ts`.
- [ ] **Step 6:** `emergency-contact/workflow.ts:41-46` — Decide: inline `shouldDemoteExistingContactForRun` at its one call site, or rename to read clearly as a boolean predicate.
- [ ] **Step 7:** Run `npm run typecheck && npm run test`.
- [ ] **Step 8:** Commit: `chore(workflows): assorted polish per review`.

---

## Phase F — Documentation drift

### Task F1: Root CLAUDE.md architecture tree

**File:** `CLAUDE.md`

- [ ] **Step 1:** Open the file and rewrite the `src/core/` block (lines 95-102 area) to reflect the nested structure. Confirm by `ls src/core/` and `ls src/core/kernel/` and `ls src/core/daemon/` and `ls src/core/task-store/`.

```
src/core/
  kernel/              # Workflow kernel
    types.ts, workflow.ts, pool.ts, session.ts, stepper.ts, registry.ts, ctx.ts,
    batch-helpers.ts, batch-lifecycle.ts, shared-context-pool.ts, run-one-item.ts
  daemon/              # Daemon mode
    types.ts, registry.ts, queue.ts, client.ts, daemon.ts, http.ts,
    worker-store.ts, keepalive.ts, child-state.ts
  task-store/          # SQLite control plane
    index.ts, enqueue.ts, claim.ts, retry.ts, complete.ts, ...
  control-db.ts, control-schema.ts, workflow-loaders.ts, find-input.ts,
  task-control.ts, task-display.ts, cli-adapter.ts (after Plan 3 Task E1)
  index.ts             # Barrel re-export
```

- [ ] **Step 2:** Update lines 103-111 (`src/systems/`) to include `sharepoint/` (verify it exists at `src/systems/sharepoint/`).
- [ ] **Step 3:** Update lines 112-123 (`src/workflows/`) to add `active-check/` and `crm-doc-download/` rows. Verify with `ls src/workflows/`.
- [ ] **Step 4:** Update line 357 — daemon implementation paths are `src/core/daemon/{types,registry,queue,client,daemon}.ts`, NOT `src/core/daemon-*.ts`.
- [ ] **Step 5:** Commit: `docs: correct architecture tree in root CLAUDE.md (kernel/daemon paths + missing workflows + sharepoint)`.

### Task F2: Root CLAUDE.md dead cross-references

**File:** `CLAUDE.md`

- [ ] **Step 1:** Line 180 and 450 — `src/LESSONS.md` references. Replace with `LESSONS.md` (project root) since `src/LESSONS.md` does not exist.
- [ ] **Step 2:** Line 438 — Remove `docs/HISTORY.md` reference (file doesn't exist) OR create the file with deferred-items content. Simplest: remove the reference.
- [ ] **Step 3:** Line 9 — "System driver work" pointer should include `sharepoint`.
- [ ] **Step 4:** Commit: `docs: fix dead cross-references in root CLAUDE.md`.

### Task F3: Root CLAUDE.md dashboard:watch + parallel-staggered + permission paths

**File:** `CLAUDE.md`

- [ ] **Step 1:** Line 68 — `dashboard:watch` description currently says "hot-reloads on src/ changes". The MEMORY note from 2026-04-?? says the Node SSE server on :3838 does not hot-reload. Qualify the description: "tsx watch restarts the SSE backend process on save (full restart, not HMR)."
- [ ] **Step 2:** Line 39 (or wherever authChain modes are listed) — Add `parallel-staggered` mode to the description if missing. Verify against `src/core/CLAUDE.md`.
- [ ] **Step 3:** Lines 204, 225, 234 — Permission-model sandbox example uses `.screenshots` but config points to `src/data/screenshots`. Update the example to use `PATHS.screenshotDir` value. Verify with `src/config.ts:16`.
- [ ] **Step 4:** Commit: `docs: clarify dashboard:watch behavior + auth modes + screenshot dir in sandbox example`.

### Task F4: Root CLAUDE.md onboarding multi-email semantics

**File:** `CLAUDE.md:30-32`

- [ ] **Step 1:** Add a one-liner clarifying multi-email positional dispatch:

```markdown
# Onboarding (daemon mode by default — see "Daemon mode" below)
npm run onboarding <email> [<email> ...]     # Enqueue each email as a separate queue item; daemon processes one at a time. Use `-p N` to spawn N daemons for parallel fan-out.
```

- [ ] **Step 2:** Commit: `docs: clarify onboarding multi-email dispatch semantics`.

### Task F5: src/core/CLAUDE.md path corrections

**File:** `src/core/CLAUDE.md`

- [ ] **Step 1:** Rewrite lines 9-13, 14-21, 22-26 to use the actual nested paths (`kernel/*`, `daemon/*`, `task-store/*`). Apply the same correction as root CLAUDE.md Task F1.
- [ ] **Step 2:** Commit: `docs(core): correct file paths in src/core/CLAUDE.md`.

### Task F6: README.md

**File:** `README.md`

- [ ] **Step 1:** Read the file. Lines 26-29, 32-33, 50-52, 60 reference scripts that don't exist in `package.json`. Either:
  - (a) Rewrite the README to match current `package.json` (preferred — keep the file useful), or
  - (b) Delete the README and link to root CLAUDE.md.

Pick (a). Walk through every npm script reference and confirm against `package.json`. Add daemon-mode semantics (`:stop`, `-n`, `-p`). Drop the `NAME` env-var row at lines 11-19 if unused (`rg "process.env.NAME" src` to confirm no consumer).

- [ ] **Step 2:** Commit: `docs: rewrite README.md against current package.json + daemon mode`.

### Task F7: src/dashboard/CLAUDE.md script list + run-with-data note

**File:** `src/dashboard/CLAUDE.md`

- [ ] **Step 1:** Lines 233-234 — Add `dashboard:tunneled` and `dashboard:watch` to the script list.
- [ ] **Step 2:** Line 79 — Cite the actual call site that respects `prefilledData` in `/api/run-with-data` (or test the behavior and update the claim accordingly). Read `src/tracker/dashboard/ops/retry.ts` or wherever the handler lives to find the gate-skip logic.
- [ ] **Step 3:** If there's a separate `src/dashboard/README.md`, decide whether to cross-link from CLAUDE.md or delete.
- [ ] **Step 4:** Commit: `docs(dashboard): add missing scripts + verify run-with-data behavior`.

### Task F8: Per-system CLAUDE.md spot-check

**Files:** `src/systems/*/CLAUDE.md`, `src/systems/*/LESSONS.md`

- [ ] **Step 1:** For each system, run `npm run test:architecture` to ensure `LESSONS.md` format guard passes. The guard requires every H2 entry to have `**Tried:** / **Failed because:** / **Fix:** / **Tags:**` (plus optional `**Selector:**` and `**References:**`).
- [ ] **Step 2:** If any lesson entries from Plan 2 Task E1 (the personal-name fix) are not yet appended, add them now.
- [ ] **Step 3:** Verify `SELECTORS.md` for each system is in sync with `selectors.ts` via `npm run selectors:catalog`. The 2026-04-?? convention drift in ServiceNow was already fixed in Plan 2 Task E7.
- [ ] **Step 4:** Commit: `docs(systems): verify LESSONS.md format compliance and catalog sync`.

### Task F9: Final docs sweep

- [ ] **Step 1:** `npm run test:architecture` — all doc-format guards should pass.
- [ ] **Step 2:** Spot-read each modified CLAUDE.md / README.md to verify they read coherently.
- [ ] **Step 3:** Update memory file `~/.claude/projects/-Users-julianhein-Documents-hr-automation/memory/MEMORY.md` if any new patterns surfaced during plan execution (e.g., new shared helpers worth remembering for future sessions).
- [ ] **Step 4:** Commit any cleanups: `docs: post-plan-3 sweep`.

---

## Phase G — Verification

### Task G1: Full repo verification

- [ ] **Step 1:** Run:

```bash
npm run typecheck:all && \
npm run test && \
npm run test:architecture && \
npm run lint
```

All must pass.

- [ ] **Step 2:** Run one OCR workflow end-to-end if env supports it: `npm run oath-upload <test-pdf-path>`. Watch dashboard, confirm OCR completes, oath-signature batch fans out, all rows transition correctly.
- [ ] **Step 3:** Run `npm run schemas:export` and confirm all 10+ workflows emit JSON Schemas (per Plan 1 Task A14, oath-signature/oath-upload/active-check/crm-doc-download should now be present).
- [ ] **Step 4:** Open dashboard, exercise: queue retry, queue delete, OCR review (Preview tab opens for prep entries, resets when deselected), FailureBell (no per-tick refetch), entries scroll smoothly with many rows.
- [ ] **Step 5:** Commit any final cleanups: `chore: post-plan-3 verification`.

---

## Out of scope for Plan 3

These items belong to Plan 1 or Plan 2 — do not attempt here:
- Kernel/daemon correctness + simplification, tracker SQLite + JSONL fixes, infra/utils/scripts work (Plan 1)
- Dashboard React fixes (`App.tsx || true`, `useEntries`, `FailureBell`, `LogStream`, `useNow`, `StepPipeline`), dashboard helpers (`IconActionButton`, `usePostAction`, `useSseHistoryStream`), dashboard performance (virtualization, memo) (Plan 2)
- System driver work (UCPath name selector, hardcoded URLs, dynamic imports, `safeClick`/`safeFill` adoption, system simplifications) (Plan 2)
- ANNUAL_DATES bump in `src/config.ts:48-50` (intentional per user; do NOT touch)
