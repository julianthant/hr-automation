# LLM Service (shared free-tier text client)

`completeJson` / `completeText` run a single text prompt across the **whole**
free-tier provider pool with automatic rate-limit fall-through — the text
sibling of `services/ocr`'s vision pool. This is the "use any available agent;
if one is rate-limited, use the next" primitive for every **non-OCR** LLM use.

## Contract

- `completeText(opts) → CompleteResult | null` — raw model text + which cell served it.
- `completeJson<T>({ ...opts, schema }) → T | null` — parsed + Zod-validated.
- **Graceful, not throwing:** returns `null` when the pool is exhausted
  (every key rate-limited / quota-out / dead / absent), the reply isn't JSON, or
  it fails schema validation. Callers degrade to "no LLM result" — an LLM
  suggestion must never fail the surrounding HR operation.
- Reuses `../ocr` infra: `buildTextPool` (env keys), `usage-tracker` (admission
  control + `reserve/commit/penalize`), `rate-limit-headers` (precise retry
  parsing). Providers/limits/model chains are the shared registry in
  `../ocr/provider-limits.ts` (Gemini → Groq → Mistral → OpenRouter → SambaNova).

## Rate-limit fall-through

`completeText` reserves the best available (provider, key, model) cell, calls it,
and on a 429 / quota / transient error `penalize`s that cell and moves to the
next model in the chain → next key → next provider, until one succeeds or
`maxWaitMs` (default 20s) is spent. State (RPD/RPM/cooldown/dead) is shared with
OCR at `cacheDir` default `.tracker/runtime`, so text + OCR respect one per-key
daily budget and never blow each other's free-tier quota.

## Consumers

- **`normalize-contact.ts`** — EC contact-field normalization (rules + LLM), wired
  as a gated OCR-orchestrator phase (see `src/workflows/ocr/CLAUDE.md`).
- **`triage.ts`** — `triageFailure(...)` explains the long-tail failures the
  deterministic `classifyError` (`src/utils/errors.ts`) can't map: category +
  cause + suggested recovery + retriable. Advisory + `null`-graceful; reads/writes
  nothing. Deliberately **not** wired into `tracked-workflow.ts`'s terminal-emit
  catch (single-terminal-write invariants — VQ-003/E2E-101/ISS-007). Consumed
  on-demand by `src/scripts/ops/triage-failure.ts`
  (`tsx --env-file=.env src/scripts/ops/triage-failure.ts "<error>" [--workflow W] [--step S] [--system SYS]`);
  the natural future hot-path home is the dashboard's background failure-pattern
  scanner, not the emit path.
- **`sanity-check.ts`** — `sanityCheckRecord(record, {rules, useLlm})` pre-submit
  gate: deterministic rule checks (email / DOB / EID formats, required fields —
  `inferRuleSpec` auto-detects field names) + an optional LLM cross-field pass
  that flags mistyped / inconsistent / OCR-garbled values. Advisory (returns
  `SanityIssue[]`, never blocks/throws; degrades to rule issues on pool
  exhaustion). Consumed on-demand by `src/scripts/ops/sanity-check-record.ts`
  (`… <record.json> [--workflow W] [--no-llm]`); the in-workflow home is right
  before an irreversible UCPath transaction / Kuali finalize, surfacing issues
  the same "suggest, human confirms" way OCR review does.
- **`selector-suggest.ts`** — `suggestSelectors({snapshot, intent, current?})`
  proposes candidate Playwright locators from a `playwright-cli` accessibility
  snapshot, ranked most-likely first. A SUGGESTION engine for the selector-map
  loop — never edits `selectors.ts`, never drives a browser. Consumed by
  `src/scripts/ops/selector-suggest.ts`
  (`playwright-cli --raw snapshot | tsx … selector-suggest.ts --intent "the Save button"`);
  the operator still verifies each candidate live + `// verified <date>` + catalog regen.

## Notes

- Text token magnitude ≠ image tokens, so candidates override `limit.imgTokens`
  with a text estimate (`estTokens`, default from prompt length). Pass a bigger
  `estTokens` for long inputs (error logs, rosters).
- JSON mode is provider-gated (`cfg.jsonMode`) exactly like the vision pool:
  Groq/OpenRouter get no `response_format`, so `completeJson` relies on the
  prompt asking for JSON + `parseJsonLoose` tolerance.
- **Future text-only providers:** Cerebras (excluded from OCR — no image input)
  is a candidate to add here for text post-processing. It would slot into
  `provider-limits.ts` as a text-capable provider once the pool distinguishes
  text-only vs vision-capable cells.
- **PII:** prompts go to third-party free tiers (may train on free-tier data).
  Keep prompts minimal and redact where possible; this is the same exposure the
  OCR path already carries, extended to new call sites — treat as a policy call.
- Tests: inject a fake `pool` + isolated `cacheDir`, and
  `__resetUsageTrackerForTests()` between cases (see
  `tests/unit/services/llm/complete.test.ts`).
