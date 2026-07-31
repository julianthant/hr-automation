# 11 — Clock, Config & Secrets

Status: **revised 2026-07-22 after the whole-plan/legacy-code review.** Configuration is now
recursively strict/branded, diagnostic redaction is part of the secret contract, and scope is
explicitly a loopback-only single-operator tool—no RBAC/multi-user infrastructure in the base.
**Amended 2026-07-31 (Round 10):** legacy and rebuild config/secret worlds remain isolated.

Answers gap-audit (`08`) TOP GAP 3 and closes config/instance, secrets, and fiscal rollover gaps.
Grounded in `src/config.ts`, settings, queue trace-id, env, and Duo credential code.

## 0. Ownership header (D1)

| Concept | Owner |
|---|---|
| The Clock — sole time-read site, freshness `now`, trace-id time-of-day, span/ledger timestamps | **This doc** |
| Config resolver — env > settings.json > default precedence, typed schema | **This doc** |
| Immutable per-run config/instance resolution + snapshot | **This doc** (fields live on doc 02's `RunEnvelope`) |
| Fiscal-year date source + rollover fail-loud | **This doc** |
| Secrets accessor (`.env` / `.auth` / Duo credential) | **This doc** |
| Local-only network boundary and secret/PII redaction classification | **This doc** |

Imports (never redefines): doc 01 `CommitTaskContract.writeSafety`; doc 02 `RunEnvelope`, field
provenance, and declared-DAG freshness walk—this doc supplies the clock/config snapshot; doc 03 span/
event wire schema (`ts: string` on `Base` — this doc supplies the value); doc 05 timeouts/
backpressure knobs (narrow this doc's config, don't re-declare precedence); doc 09 write-safety
ledger (`write.attempting`/`write.committed` timestamps — this doc's Clock, doc 09's events); doc
12 evidence/diagnostic bundles consume this doc's redaction classifications.

---

## 1. Grounding — what exists today, why it hurts

- **No central clock.** `grep -c "new Date(" src` = 238, `grep -c "Date\.now(" src` = 207 → **445
  direct wall-clock reads**, zero abstraction, confirmed against the gap audit's figure. The one
  disciplined pattern, `buildTraceId({ at })` (`queue-trace-id.ts:76-82`), takes `at` as a
  parameter specifically to stay pure and testable — but every production caller defeats it with
  `at: new Date()` inline (`tracked-workflow.ts:229`, `run-one-item.ts:441`, `ocr/orchestrator.ts:
  404`). `todayLocal()`-shaped date-partition formatting is duplicated ad hoc in ≥4 places
  (`jsonl-core.ts:31`, `deletions/store.ts:13`). Injectability today is scattered private
  `now?: () => number` params (`duo-webauthn.ts:580`, `identity.ts:154`) — each hand-rolled, none
  shared.
- **Config is a real single-source with re-implemented precedence.** `src/config.ts` +
  `domain/settings/types.ts` + `tracker/settings/store.ts` already do `env > settings.json >
  default` correctly (verified reading `config.ts` in full) — but the precedence expression
  (`process.env.X ?? SETTINGS.y.z`) is written out at **every individual read site** (`KUALI_SPACE_
  URL`, `ANNUAL_DATES.jobEndDate`, `getTimekeeperName`, …: 8 separate call sites in `config.ts`
  alone), and the code-default literal is duplicated between `config.ts` and `DEFAULT_OPERATOR_
  SETTINGS` (`types.ts:229-273`) with a hand-maintained comment as the only thing keeping them in
  sync. Several knobs escape the settings schema entirely (`I9_APP_URL`, `CRM_SECTION_URLS`).
  **URL overrides are process-global** — `SETTINGS.urls.*` applies to every run in the process;
  there is no way to send one run at a test instance while another (concurrently) hits production.
- **Secrets: one good choke, leaky edges.** `validateEnv()` (`utils/env.ts:33-49`) is a clean,
  batch, fail-loud gate for the two UCPath SSO vars — but `HRAUTO_DASHBOARD_LAN_PASSWORD`, the
  `.auth/duo-webauthn.json` private-key file (`DUO_WEBAUTHN_CREDENTIAL_PATH`,
  `infra/auth/duo-webauthn.ts:37`), and ~20 files reading `process.env.*` inline sit outside it.
  `getTimekeeperName()` (`config.ts:119-123`) is a second, independent throw-loud pattern — correct
  in isolation, but a second place, not the one place.
- **Fiscal dates are static, mirrored, and already stale.** `ANNUAL_DATES.jobEndDate` defaults to
  `"06/30/2026"` (`config.ts:109-113`, mirrored in `types.ts:232`) — today is 2026-07-18. The value
  is already past and nothing detects or flags it; the next run that consumes it silently fills a
  date that already lapsed.

---

## 2. The Clock

**One injectable interface is the sole permitted site of `new Date()`/`Date.now()` in `temp_src`.**
Every timestamp in the rebuilt system—span `ts`, checkpoint fact `observedAt`/`correctedAt`, trace-id time-of-day,
write-safety ledger events (doc 09), fiscal-year lookups — reads through it.

```ts
// temp_src/domain/clock.ts — the ONLY file in temp_src allowed to call new Date()/Date.now()
export interface Clock {
  /** Current wall-clock instant; every calendar/serialized-time helper derives from this. */
  now(): Date;
  nowMs(): number;
  /** Process-monotonic milliseconds for elapsed budgets/durations; never serialized as an instant. */
  monotonicMs(): number;
  /** Local calendar day, YYYY-MM-DD — tracker partitioning, one impl (replaces 4 ad-hoc copies). */
  todayLocal(): string;
  /** HHMMSS local time-of-day — feeds buildTraceId(at); ported verbatim from queue-trace-id.ts. */
  timeOfDayCode(at?: Date): string;
  /**
   * UC fiscal year containing `at` (default now()). UC's fiscal year runs Jul 1–Jun 30 and is
   * NAMED by its ending calendar year — Jul 1 2026–Jun 30 2027 is "FY2027". Pure arithmetic:
   * `at.getMonth() >= 6 /* Jul */ ? at.getFullYear() + 1 : at.getFullYear()`.
   */
  fiscalYear(at?: Date): number;
}

/** Production Clock — reads the OS. The only place `new Date()`/`Date.now()` actually execute. */
export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
  todayLocal() { return localDatePart(this.now()); },
  timeOfDayCode(at = this.now()) { return formatTraceTimestamp(at); },  // ported from queue-trace-id.ts
  fiscalYear(at = this.now()) { return at.getMonth() >= 6 ? at.getFullYear() + 1 : at.getFullYear(); },
};

/** Deterministic test Clock — wall and monotonic values are independently advanceable so skew and
 * elapsed-budget behavior can be tested without sleeping. */
export function manualClock(at: Date, monotonicMs = 0): TestClock { /* advanceWall/advanceMonotonic */ }
```

**Composition with existing contracts (nothing else changes shape — only the `now` input):**

- **Doc 02 §5.5 freshness walk.** `now − fact.observedAt > fieldLimit` reads `clock.now()`. This
  makes the freshness *safety* computation unit-testable for the first time — a `manualClock` test
  can assert the exact boundary (`maxAgeMs` exactly exceeded vs. not) without waiting real time.
- **Doc 03 spans.** The executor holds one `Clock` instance; every `SpanEvent.ts` (`Base.ts: string`
  in doc 03 §2) is `clock.now().toISOString()`, stamped once at emission, never re-derived.
- **Trace ids.** `buildTraceId({ code, runId, at: clock.now() })` — the function itself
  (`queue-trace-id.ts`) ports verbatim (it was already pure); only the caller changes from
  `at: new Date()` to `at: clock.now()`.
- **Doc 09 write-safety ledger.** `write.attempting`/`write.committed` timestamps and the crash-
  window fence read `clock.now()` — same executor-held instance as spans, so a fence and its span
  are never timestamped by two different clock reads.
- **Doc 09 prewrite age.** `probeToFenceMaxMs` uses `clock.monotonicMs()` at probe completion and
  immediately before the fence. Wall-clock correction cannot make an over-age probe look fresh;
  expiration discards staged page state and restarts preflight.
- **Checkpoint provenance timestamps**—live observations and operator corrections use the Clock;
  an operator correction does not replace the original observation time.

**The guard (registered in doc 10's guard-of-guards manifest):**
`tests/unit/architecture/clock-single-source.test.ts` — bans `new Date(` / `Date.now(` /
`performance.now(` / direct `process.hrtime` anywhere in
`temp_src/**` **except** `temp_src/domain/clock.ts`, using the same `Record<file,{count,reason}>`
shrink-only-allowlist mechanism as `wait-for-timeout-allowlist.test.ts`: a **ported leaf** (e.g. a
verbatim-ported selector helper with an inline timestamp) may carry a shrinking allowlist entry;
**new `temp_src` code gets zero tolerance.** A second guard, `manual-clock-test-only.test.ts`, bans
importing `manualClock` outside `*.test.ts` / `tests/**` — a `manualClock` import in production code
is a symptom of accidentally wiring the test double into a real executor.

---

## 3. Config resolver

**One resolver function implements `env > settings.json > default` exactly once.** Every current
read site's inline `process.env.X ?? SETTINGS.y.z ?? literal` expression is replaced by a call into
this resolver; the precedence logic itself is never repeated.

```ts
// temp_src/domain/config/schema.ts — the ONE place defaults live (kills the config.ts ↔
// DEFAULT_OPERATOR_SETTINGS duplication the gap audit flagged at types.ts:226)
const UcpathRoutesSchema = z.strictObject({ entry: UrlSchema, personOrg: UrlSchema,
                                            smartHr: UrlSchema, transactions: UrlSchema });
const CrmRoutesSchema = z.strictObject({ entry: UrlSchema, onboarding: UrlSchema,
                                         contacts: UrlSchema });
// Each system owns an equally closed route object. Adding a route is a schema change; misspelling
// one is an unknown-key error. There is no open Record<string,url> on runtime decision data.
const systemEndpoints = <R extends z.ZodType>(routes: R) => z.strictObject({
  prod: routes,
  test: routes.optional(),
});

export const ConfigSchema = z.strictObject({
  urls: z.strictObject({
    kuali: systemEndpoints(KualiRoutesSchema), newKronos: systemEndpoints(NewKronosRoutesSchema),
    crm: systemEndpoints(CrmRoutesSchema), onbase: systemEndpoints(OnBaseRoutesSchema),
    ucpath: systemEndpoints(UcpathRoutesSchema), i9: systemEndpoints(I9RoutesSchema),
    oldKronos: systemEndpoints(OldKronosRoutesSchema),
    servicenow: systemEndpoints(ServiceNowRoutesSchema),
    sharepoint: systemEndpoints(SharePointRoutesSchema),
  }).default({
    // Full parent defaults—not `.default({})`. Each `prod` map is ported from the current
    // constants, including all CRM subroutes; `test` is absent until explicitly configured.
    kuali: { prod: KUALI_PROD_ENDPOINTS }, newKronos: { prod: NEW_KRONOS_PROD_ENDPOINTS },
    crm: { prod: CRM_PROD_ENDPOINTS }, onbase: { prod: ONBASE_PROD_ENDPOINTS },
    ucpath: { prod: UCPATH_PROD_ENDPOINTS }, i9: { prod: I9_PROD_ENDPOINTS },
    oldKronos: { prod: OLD_KRONOS_PROD_ENDPOINTS },
    servicenow: { prod: SERVICENOW_PROD_ENDPOINTS },
    sharepoint: { prod: SHAREPOINT_PROD_ENDPOINTS },
  }),
  timeouts: z.strictObject({
    navigationMs: z.number().int().positive(),
    taskMs: z.number().int().positive(),
    transactionMs: z.number().int().positive(),
    /* … */
  }).default({ navigationMs: 15_000, taskMs: 180_000,
                        transactionMs: 300_000, /* every required sibling */ }),
  paths: z.strictObject({ reportsDir: AbsolutePathSchema, stateBackupDir: AbsolutePathSchema,
                          /* … */ }).default({ /* full user-agnostic defaults */ }),
  /** Keyed by fiscal year ("FY2027"), NOT a flat literal — see §5. */
  annualDates: z.record(FiscalYearKeySchema, AnnualDateEntrySchema).default({}),
  operator: z.strictObject({ timekeeperName: z.string() }).default({ timekeeperName: "" }),
  capture: z.strictObject({
    ingress: z.enum(["disabled", "on-demand-ngrok", "forwarded"]),
    forwardedUrl: HttpsUrlSchema.optional(),
    preConnectTtlMs: z.number().int().positive(),
    activeIdleTtlMs: z.number().int().positive(),
    maxPhotoBytes: z.number().int().positive(),
    maxPhotos: z.number().int().positive(),
  }).default({ ingress: "on-demand-ngrok", preConnectTtlMs: 15 * 60_000,
               activeIdleTtlMs: 60 * 60_000, maxPhotoBytes: 20_000_000, maxPhotos: 100 }),
  providers: ProviderBudgetConfigSchema, // every D63 capability: models, timeout, concurrency/rate/cost
  // … browserHealth / concurrency / daemon / ocr / features: ported 1:1 from
  // domain/settings/types.ts, now zod-typed instead of a hand-written interface.
});
export type Config = z.infer<typeof ConfigSchema>;
```

The route entries above are deliberately exhaustive over doc 01's current `BrowserSystemId`, not a
sample of the most common systems. D68 coverage fails if a browser system lacks its closed endpoint
schema/defaults or if an endpoint schema has no driver consumer. Naming follows the domain ids:
`old-kronos` is represented by `oldKronos`, never an ambiguous parallel `ukg` key.

```ts
// temp_src/domain/config/resolve.ts
/** One declarative table replaces every scattered `process.env.X ?? …` read site. */
const ENV_KEY_MAP = {
  "urls.kuali.test.entry": "KUALI_SPACE_URL_OVERRIDE",
  "annualDates.*.jobEndDate": "ANNUAL_DATES_END",     // resolved against the CURRENT fiscal year only
  "annualDates.*.kronosDefaultEndDate": "KRONOS_DEFAULT_END_DATE",
  "annualDates.*.kronosDefaultStartDate": "KRONOS_DEFAULT_START_DATE",
  "operator.timekeeperName": "TIMEKEEPER_NAME",
  "ocr.secondOpinionMax": "OCR_SECOND_OPINION_MAX",
  // … every OperatorSettingsOverride ↔ env-var pair from applyOperatorSettingsEnv, ported verbatim
} as const satisfies Partial<Record<EnvBackedConfigLeafPath, EnvVarName>>;

// SettingsOverrideSchema migrates today's sparse "System URLs" values into `urls.<system>.test`.
// It can never replace `prod`; selecting the test endpoint is an explicit RunEnvelope decision.

// The sparse override schema itself accepts absent input and defaults it to one empty strict object;
// callers do not improvise `?? {}` fallbacks.
const SettingsOverrideInputSchema = SettingsOverrideSchema.optional().default({});
export function resolveConfig(env: NodeJS.ProcessEnv, settingsOverride: unknown): Config {
  const withDefaults = ConfigSchema.parse({});                 // zod .default() fills every leaf — ONE source
  const withSettings = deepMergeNonEmpty(withDefaults, SettingsOverrideInputSchema.parse(settingsOverride));
  const withEnv = applyEnvPrecedence(withSettings, ENV_KEY_MAP, env);  // explicit env wins, treats "" as unset
  return ConfigSchema.parse(withEnv);                           // final validation — a bad env/settings value throws here
}

export interface ResolvedConfig {
  config: Config; // plain values consumed by runtime code
  provenance: Readonly<Record<ConfigLeafPath, "env"|"settings"|"default">>;
  fingerprint: string;
}
export function resolveConfigWithProvenance(env: NodeJS.ProcessEnv, settings: unknown): ResolvedConfig;
```

- **"Empty settings = today's behavior" invariant, structurally guaranteed, not hand-maintained.**
  Because the defaults live in exactly one place (the zod schema's `.default()`s), there is no
  second literal to drift out of sync — the duplication `types.ts:226`'s comment currently warns
  about cannot recur. `resolveConfig(process.env, {})` reproduces the schema defaults by
  construction. A `config-schema-snapshot.test.ts` still pins the literal default *values*
  themselves (so an accidental edit to a default URL/timeout is caught in review, same spirit as
  today's mirrored-literal safety net, but with one source instead of two).
- **Workflow/system configs narrow, they never redeclare.** `temp_src/stores/ucpath/config.ts`
  calls `resolveSystemEndpoints(snapshot, "ucpath")`—a thin selector over the run's resolved
  `prod`/`test` endpoint map, never its own `env > settings > default` expression. Production and
  sparse test endpoints are distinct fields, so a settings override cannot silently retarget a prod
  run. This directly closes gap #4's "precedence re-implemented per read-site" finding.
- **Effective value + source, surfaced.** `resolveConfig` returns plain `Config` exactly as typed.
  `resolveConfigWithProvenance` returns `{config, provenance, fingerprint}` so Settings can show the
  read-only transparency the old dashboard already has (`.env` Credentials panel) — this is what
  closes the "precedence-shadowing" risk (§7).

---

## 4. Immutable per-run config and instance snapshot — required in Phase 1

Every run and ledger entry must say which environment/config actually governed it. The request may
omit instance preferences (meaning production), but enqueue always resolves and stamps a complete
snapshot; runtime tasks never re-read mutable process settings mid-run.

```ts
// amends doc 02's RunEnvelope — doc 02 remains the OWNER of RunEnvelope's shape; this field is
// specified HERE because instance selection is this doc's concept (D1), same pattern as dryRun (D6)
// living on the envelope but being fully specified in doc 02.
interface RunEnvelope {
  // … runId, workflow, itemId, traceId, parent, shape, dryRun, startAt, injected,
  //    freshnessOverride, retryOf, attempt, enqueuedAt (doc 02 §2, unchanged) …
  /**
   * Per-system instance targeting. ABSENT (the default) means every system this run touches
   * resolves to PRODUCTION — the loud-safe default. A system present here as `"test"` means this
   * run's tasks against that system resolve config from the settings.json test-URL override
   * instead of the production literal.
   */
  requestedInstance?: Partial<Record<BrowserSystemId, "prod" | "test">>;
  /** Exact keys are the descriptor-derived browser systems touched by this run; no extras or
   * omissions survive RunEnvelopeSchema validation. */
  resolvedInstance: Partial<Record<BrowserSystemId, "prod" | "test">>;
  configFingerprint: Fingerprint;
  configSnapshotId: ConfigSnapshotId; // immutable SQLite row containing non-secret effective values+sources
}
```

- **Loud default, never silent.** Omitting `requestedInstance` resolves
  every system to production, matching current behavior byte-for-byte. There is no implicit "test"
  state to fall into by omission.
- **Fail-loud mismatch check, at resolve time.** `resolveSystemUrl(config, systemId, requested)`:
  - `requested === "prod"` (default) → always the production literal. Cannot be silently
    redirected to test by a stray settings.json edit — production is the code-default, not a
    settings value that could accidentally be left pointing at a sandbox.
  - `requested === "test"` but no distinct test URL is configured for that system (the settings
    override is empty or equals the production literal) → **throws**: `"run <runId> requested TEST
    instance for <system> but no test URL is configured (urls.<system> is empty/matches
    production) — refusing to silently run against production."` This is the structural
    impossibility the charter asks for: a run that believes it's hitting a sandbox can never
    silently land on production.
- **Recorded in the audit trail.** `RunQueued.resolvedInstance` (doc 03's span schema) carries the resolved
  map (even when empty/all-prod) — so every run's actual target, per system, is queryable from the
  ledger (gap-audit gap 5), not inferred.
- **Executor pool partitioning.** Browser contexts are keyed by `(system,resolvedInstance,
  configFingerprint)`. Prod/test runs never share a context. A config change creates new contexts;
  existing runs finish against their stamped snapshot.

---

## 5. Fiscal-year dates — fail-loud, not silently stale

Today's `ANNUAL_DATES` is a flat, single-year literal that has no rollover mechanism and is already
past due (`jobEndDate: "06/30/2026"`, today 2026-07-18). The rebuild makes staleness a **loud
failure at the point of use**, not a silently-wrong fill.

- **Keyed by fiscal year, not flat.** `Config.annualDates: Record<"FY${number}", AnnualDateEntry>`
  (§3's schema). There is no single "the" `jobEndDate` — there is `annualDates["FY2027"]
  .jobEndDate`, looked up by the Clock.
- **Intentional dynamic-map exception.** Fiscal years are unbounded configuration keys rather than
  domain field names, so this constrained `z.record(FiscalYearKeySchema, AnnualDateEntrySchema)` is
  allowed. The strict config parser validates every key and every value; no task reads it directly,
  and `requireAnnualDates` returns exactly one typed current-year entry or throws.
- **`requireAnnualDates(config, clock)`** — the one call site every consumer (onboarding hire-date
  fill, Kronos report range fill) goes through:

```ts
export function requireAnnualDates(config: Config, clock: Clock): AnnualDateEntry {
  const fy = `FY${clock.fiscalYear()}`;
  const entry = config.annualDates[fy];
  if (!entry) {
    throw new FiscalDateNotConfiguredError(
      `no ANNUAL_DATES configured for ${fy} (today ${clock.todayLocal()} falls in ${fy}, ` +
      `Jul 1 ${clock.fiscalYear() - 1} – Jun 30 ${clock.fiscalYear()}). Add config/settings.json ` +
      `→ annualDates.${fy} = { jobEndDate, kronosDefaultEndDate, kronosDefaultStartDate }, or set ` +
      `ANNUAL_DATES_END / KRONOS_DEFAULT_END_DATE / KRONOS_DEFAULT_START_DATE for this year.`
    );
  }
  assertNotPast(entry.jobEndDate, clock);   // see below — an ENTRY existing is not enough
  return entry;
}
```

- **A second, narrower check: an existing-but-stale entry is also loud, not just a missing one.**
  A copy-pasted-forward entry (this year's key holding last year's date by operator mistake) would
  pass the lookup above but still be wrong. `assertNotPast(entry.jobEndDate, clock)` parses the
  date and throws if it is chronologically before `clock.now()` — this is the exact "already stale"
  failure mode gap-audit gap 7 names, closed structurally rather than by operator vigilance.
- **This is the charter's fail-loud rule, applied verbatim** (root `CLAUDE.md` §"Fail loud"): a
  fiscal date is "an expected value" whose absence/staleness is not a "genuinely valid, expected
  state" (a hire-date fill genuinely needs a *current* fiscal year's date) — so it fails loud
  instead of substituting the nearest available literal.
- **Rollover is then a config edit, not a code deploy.** Adding `annualDates.FY2028` to
  `config/settings.json` (or the equivalent env vars) each June is the entire rollover procedure —
  same operator action as today, but now a missed rollover is caught at the first onboarding/
  separation run that needs it, not discovered months later.

---

## 6. Secrets accessor

One typed accessor is the sole rebuild home for every credential—rebuild-scoped `.env` resolution
and a distinct rebuild auth/profile root—replacing inline reads inside `temp_src`. Production
`src` keeps its existing config/secret world unchanged. The two runtimes never import accessors,
read each other's settings/state/auth files, or proxy requests.
Within `temp_src`, the accessor covers environment variables and the rebuild Duo
private-key file — replacing `validateEnv()` + `getTimekeeperName()` + ~20 files' inline
`process.env.*` reads with one surface. No legacy-proxy secret/config class exists.

```ts
// temp_src/domain/secrets.ts
interface SecretSpec { env: string; required: boolean }

const SECRETS = {
  ucpathUserId:      { env: "UCPATH_USER_ID", required: true },
  ucpathPassword:     { env: "UCPATH_PASSWORD", required: true },
  timekeeperName:     { env: "TIMEKEEPER_NAME", required: false },  // lazy-required — see below
  // Provider key families are registered patterns, not ad-hoc process.env scans. The existing
  // Gemini 1..8 pool and each provider's supported cardinality are explicit in the spec.
  geminiApiKeys:      { envFamily: "GEMINI_API_KEY{1..8}", required: false },
  groqApiKeys:        { envFamily: "GROQ_API_KEY{n}", required: false },
  mistralApiKeys:     { envFamily: "MISTRAL_API_KEY{n}", required: false },
  openRouterApiKeys:  { envFamily: "OPEN_ROUTER_API_KEY{n}", required: false },
  sambaNovaApiKeys:   { envFamily: "SAMBANOVA_API_KEY{n}", required: false },
  ngrokCredential:    { source: "local-ngrok-config", required: false },
} as const;
type SecretName = keyof typeof SECRETS;

const SECRET_FILES = {
  duoWebauthnCredential: { configPath: "paths.duoCredential", classification: "credential-file" },
} as const;
type SecretFileName = keyof typeof SECRET_FILES;

/** Throws SecretMissingError naming the secret + its env var + .env.example pointer. Never `?? ""`. */
export function requireSecret(name: SecretName): string { /* … */ }
export function optionalSecret(name: SecretName): string | undefined { /* … */ }

/**
 * `timekeeperName` and any similarly-lazy secret stays "required: false" in the table (so process
 * boot doesn't demand it for workflows that never touch Kuali) but IS on the mandatory-at-startup
 * list for any run whose descriptor reaches a Kuali fill task — the descriptor declares which
 * secrets its tasks need (a `requires: SecretName[]` on the contract, mirroring doc 01's session
 * needs), so "lazy" is descriptor-driven, not a second ad hoc throw site.
 */

/** Batch gate at process boot — ports validateEnv()'s all-missing-at-once reporting. */
export function validateRequiredSecrets(): void {
  const missing = (Object.keys(SECRETS) as SecretName[]).filter(
    (n) => SECRETS[n].required && !process.env[SECRETS[n].env],
  );
  if (missing.length) throw new SecretMissingError(missing.map((n) => SECRETS[n].env));
}

/** Named file secrets only—callers cannot turn this into an arbitrary path reader. */
export function requireSecretFile(name: SecretFileName): Buffer { /* resolve configured path,
  validate owner/mode/type/size, read or throw a named SecretFileError */ }
```

This block is the intended **registry shape**, not permission to stop at the shown entries. Phase
1b's D68 inventory starts from `.env.example`, all current `process.env`/computed-env reads (including
provider key/model families), `.auth`, capture tooling, and each descriptor's requirements. Every
entry is classified as secret, non-secret config, test-only, or retired-in-target; every rebuild runtime
read maps back to exactly one entry. Optional provider keys remain optional globally but become a
blocking workflow/feature preflight when a required provider capability has no usable configured
cell.

- **Fail-loud at startup, ported pattern.** `validateRequiredSecrets()` runs once at daemon/
  dashboard boot (successor to today's `validateEnv()` call), throwing with every missing var named
  at once — not one at a time across three separate run failures.
- **Never logged.** The accessor is the only function permitted to read a secret's raw value; every
  other module receives it as an opaque string to hand to a login/fill call, never to `log.*`. A
  grep-ratchet guard (below) backstops this structurally.
- **`.auth/` and Duo credentials get one owned home.** `requireSecretFile("duoWebauthnCredential")`
  replaces the direct `readFileSync` in `infra/auth/duo-webauthn.ts:1` — the cross-process
  lock and signCount-reservation logic (live-verified, ported verbatim per the charter) stay
  exactly as they are; only the raw-file-read call site changes to go through this accessor.
- **Redaction is schema-owned.** Secret schemas and sensitive domain fields carry a classification
  (`secret`, `credential-file`, `direct-identifier`, `sensitive-hr`, or `safe-diagnostic`) plus an
  allowed evidence transform (`drop`, `digest`, `last4`, `basename`, `count`, or `allow`). Doc 12's
  logger/evidence/bundle writers accept classified values and transform before serialization.
  Unknown/unclassified fields are dropped with a redaction warning, never passed through. Tests
  seed canary passwords, cookies, storage state, SSNs, DOBs, and private keys and scan every
  produced note/failure/screenshot metadata/bundle/notification.

**The guard:** `secrets-single-source.test.ts` — bans `process.env.` outside `domain/secrets.ts`
and `domain/config/` (the config resolver's own env-precedence reads are a distinct, permitted
concern from secret *values*; the guard's allowlist distinguishes a config *URL* env read from a
*credential* env read by the `SECRETS`/`ENV_KEY_MAP` table membership). `no-secret-values-in-logs.
test.ts` — a grep-ratchet flagging `log.*`/template-literal interpolation of identifiers named
`password`/`privateKey`/`credential`/`secret` (case-insensitive), same `Record<file,{count,reason}>`
shape as the existing ratchets, catching an accidental `log.info(`login as ${password}`)`.

### 6.1 Explicit single-operator/local scope

The rebuilt operator dashboard binds `127.0.0.1`/`::1` only. Phase 1 does not build accounts, roles,
permissions, teams, remote synchronization, high availability, a secret manager, certificate
management, or signed audit anchoring. Legacy-only LAN configuration remains inside preserved
`src` and is never imported/proxied into `temp_src`. A non-loopback
bind is rejected by the native server with a message that remote access is outside the current
contract; adding it later requires a separate threat model and explicit operator decision.

Doc 06's mobile capture is the sole explicit exception and does not turn the operator server into a
remote app. `capture.ingress:"on-demand-ngrok"` starts a short-lived separately scoped ingress only
after the operator creates a capture session; `forwarded` requires an explicit HTTPS URL;
`disabled` makes Start Capture fail with a named configuration result. The ingress exposes the
closed token-gated phone-route union only and shuts down after the last live session expires or
finishes. Its route allowlist is generated from the same capture-route schema and deny-tests every
operator/API catch-all. `forwardedUrl` is routing config, never authority; each capture session
stamps the resolved ingress mode/origin digest so troubleshooting can explain which path was used.
`ConfigSchema.superRefine` requires `forwardedUrl` exactly for `ingress:"forwarded"` and rejects it
for the other modes, so a stale forwarded origin cannot be silently reused.

Local-only does **not** waive correctness or privacy hygiene. The tool still controls live HR
systems and stores sensitive evidence, so strict schemas, output redaction, least-retained capture,
file permissions (`0700` directories / `0600` authority, backup, evidence, and secret files),
loopback Origin checks, and no secret-bearing URLs/logs remain base requirements. These measures
also make diagnostic bundles safer to share with Codex/Claude.

### 6.2 One environment doctor replaces scattered startup surprises

The existing `setup`, `/api/preflight`, and `test-login` behaviors become projections of one strict
preflight registry, not three lists that drift. Each `PreflightCheck` has a stable id, scope
(`dashboard|executor|workflow|system|feature`), severity, pure/IO runner, timeout, redaction policy,
and remediation template. `PreflightReportSchema` contains config/descriptor fingerprints, checked
at/time, and a non-empty closed result tuple:

```ts
type PreflightResult =
  | { status: "pass"; check: PreflightCheckId; summary: string }
  | { status: "warning"; check: PreflightCheckId; summary: string;
      impact: string; remediation: string }
  | { status: "fail"; check: PreflightCheckId; summary: string;
      blocks: readonly [RuntimeCapability, ...RuntimeCapability[]]; remediation: string };
```

Base checks cover Node/package-lock compatibility, Playwright browser/extension assets, configured
paths and permissions, disk space, port availability, SQLite/migration/backup health, required
workflow secrets, production/test URL completeness, current fiscal dates, optional provider-key
availability, capture ingress dependencies, and stale orphan processes/leases. Rules:

- dashboard boot blocks only on checks required to read authority/serve safely; missing credentials
  for an unused workflow are visible warnings, not a reason the local dashboard cannot open;
- enqueue/daemon start runs the descriptor-derived workflow/system/feature subset and rejects before
  launch if any required capability fails—no Duo/browser is spent on a doomed run;
- optional AI/capture checks report the exact unavailable feature; they never masquerade as healthy
  and never block unrelated workflows;
- `cli doctor [--workflow <id>]`, Settings health, startup logs, and `test-login` consume the same
  results. `test-login` adds bounded live authentication checks but cannot mutate HR data;
- doctor never auto-installs packages, edits `.env`, changes settings, kills processes, restores a
  DB, or opens a tunnel. It offers exact explicit commands/actions and records only redacted facts.

The registry has forward/reverse coverage: every blocking runtime prerequisite is referenced by at
least one check, and every check has a consumer and scenario. Fixtures pin missing browser, stale
fiscal year, bad test URL, low disk, corrupt DB, missing workflow-specific secret, optional provider
exhaustion, unavailable ngrok, and healthy mode.

---

## 7. Adversarial self-review

| Vector | Risk | Guard |
|---|---|---|
| A config default masks a genuinely missing value (empty URL silently = production) | An operator who *meant* to set a test URL, typo'd it empty, unknowingly runs against production | This is the charter's "verified + genuinely valid" exception, not a masked failure: empty-URL-means-production is a **documented, verified** default (every URL's production literal is the live-verified value already in `config.ts` today) — not a guess. What closes the *dangerous* half (test intended, prod delivered) is §4's fail-loud instance-selection check, which is orthogonal to and stricter than the plain config default |
| Stale fiscal-date fallback | A rollover is missed; last year's date silently reused | §5: missing-FY throws; existing-but-past-due entry ALSO throws (`assertNotPast`) — closes both the "nobody rolled it over" and "somebody rolled it over wrong" cases |
| Clock skew (host OS clock is wrong) | Freshness comparisons and trace-id time-of-day become wrong in lockstep | constant skew cancels in `now-observedAt`; changing skew remains residual; compare monotonic vs wall clock and warn/park on a large backward jump |
| `manualClock` (test double) leaks into a production executor | A daemon silently runs with a frozen clock — every trace id, span, and freshness check wrong in the same way, all at once, no crash | `manual-clock-test-only.test.ts` — import-site guard, `manualClock` only importable from `*.test.ts`/`tests/**` |
| `ENV_KEY_MAP` typo (env var name misspelled, or a schema leaf added without a matching env entry) | An operator sets an env var that silently does nothing (the resolver never looks for it) | `config-env-map-coverage.test.ts` — asserts every schema leaf marked `envBacked` in a leaf-level annotation has exactly one `ENV_KEY_MAP` entry, and every `ENV_KEY_MAP` entry resolves to a real schema path (bidirectional coverage, same shape as the existing registry-parity guards) |
| Runtime re-reads config after enqueue | one run changes target/timeouts mid-flight or ledger mislabels instance | immutable snapshot/fingerprint on envelope; contexts partitioned by snapshot; guard bans config resolution from task impls |
| Resolver return type drifts | consumers expect plain values but receive provenance wrappers | type test pins `resolveConfig():Config` and `resolveConfigWithProvenance():ResolvedConfig` separately |
| A route name typo is accepted by an open endpoint map | driver navigates to missing/wrong route and a fallback hides it | per-system strict route schemas; unknown/missing route keys fail config parse and every driver route reference is coverage-checked |
| Diagnostic bundle copies sensitive state because a new field lacks a classifier | credentials/HR data leak into debugging artifacts | unclassified means drop, never allow; canary redaction test scans all serializers and attachments |
| A “temporary” LAN bind turns the local tool into a multi-user surface | unaudited remote control of live HR automation | operator server rejects non-loopback addresses; architecture/config test pins no LAN-password/RBAC path and separately proves the temporary capture ingress exposes only its closed phone-route union |

---

## 8. Worked example

**A live onboarding hire-date fill against production, everything resolved from its one source:**

```ts
const clock = systemClock;
const config = resolveConfig(process.env, readOperatorSettingsOverride());
validateRequiredSecrets();                                    // throws loud if UCPATH_USER_ID/PASSWORD unset

const runId = crypto.randomUUID();
const traceId = buildTraceId({ code: "ou", runId, at: clock.now() });   // §2 — Clock supplies `at`

const ucpathUrl = resolveSystemUrl(config, "ucpath", envelope.resolvedInstance.ucpath);

const annualDates = requireAnnualDates(config, clock);         // §5 — FY2027 entry, not past-due; else throws
const ucpathPassword = requireSecret("ucpathPassword");        // §6 — throws loud if unset, never logged

// … task runs, checkpoint facts record observedAt from clock; configSnapshotId stays fixed …
// span.ended(run, "done") — all-prod resolved map + config fingerprint recorded
```

**The same run one fiscal year later, nobody rolled the dates over:**

```ts
const annualDates = requireAnnualDates(config, clock);
// throws:
// FiscalDateNotConfiguredError: no ANNUAL_DATES configured for FY2028 (today 2027-07-03 falls in
// FY2028, Jul 1 2027 – Jun 30 2028). Add config/settings.json → annualDates.FY2028 = { jobEndDate,
// kronosDefaultEndDate, kronosDefaultStartDate }, or set ANNUAL_DATES_END / KRONOS_DEFAULT_END_DATE
// / KRONOS_DEFAULT_START_DATE for this year.
```

The run parks before touching UCPath — no hire-date fill is ever attempted with a stale or absent
fiscal literal.

---

## 9. Settled design questions

1. ~~Secret requirement timing~~ — **resolved 2026-07-21:** descriptors derive `requires` from task
   contracts; enqueue checks the complete set before creating a run. Per-task `requireSecret()`
   remains a fail-loud defense-in-depth backstop, not the primary discovery mechanism.
2. ~~Clock-skew detection~~ — **resolved:** durations use monotonic time; the executor compares wall
   vs monotonic deltas and emits a loud health warning/pauses new commits on material backward wall
   jumps until the operator acknowledges. Existing runs never rewrite timestamps.
3. ~~`ENV_KEY_MAP` for URLs~~ — **resolved:** only intentionally supported leaves appear in the
   explicit map. No reflection/uniform "every leaf" override. Production endpoint maps remain code
   defaults; settings and named URL env vars populate sparse test maps only.
4. ~~Fiscal-year entry authoring UI~~ — **resolved:** schema/file authoring works in Phase 1;
   operator UI lands when native Settings migrates under doc 03's scoped-flip sequence. Until then,
   Settings proxies old controls and the validated JSON entry is the supported new-config path.
5. ~~Per-run config snapshot timing~~ — **resolved 2026-07-21:** required in Phase 1 because every
   write ledger record needs trustworthy instance/config provenance even when all runs are prod.
