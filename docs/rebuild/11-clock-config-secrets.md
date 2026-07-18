# 11 — Clock, Config & Secrets

Status: **Phase 0 design — for operator/orchestrator review.** Answers gap-audit (`08`) TOP GAP 3
in full and closes gap-audit findings #4 (config/instance selection), #6 (secrets), #7 (fiscal
rollover). Grounded in `src/config.ts`, `src/domain/settings/types.ts`, `src/tracker/settings/
store.ts`, `src/domain/queue-trace-id.ts`, `src/utils/env.ts`, `src/infra/auth/duo-webauthn.ts`.

## 0. Ownership header (D1)

| Concept | Owner |
|---|---|
| The Clock — sole time-read site, freshness `now`, trace-id time-of-day, span/ledger timestamps | **This doc** |
| Config resolver — env > settings.json > default precedence, typed schema | **This doc** |
| Per-run test-vs-production instance selection (design; scope-optional-now) | **This doc** (field lives on doc 02's `RunEnvelope`, which this doc amends by reference — doc 02 does not redefine it) |
| Fiscal-year date source + rollover fail-loud | **This doc** |
| Secrets accessor (`.env` / `.auth` / Duo credential) | **This doc** |

Imports (never redefines): doc 01 `MutateTaskContract.receipt`/`idempotency` (write-safety ledger
timestamps consume the Clock, don't own it); doc 02 `RunEnvelope` (D6 `dryRun`, D8 `freshness.
maxAgeMs`, the bind-graph walk — this doc supplies the `now` those mechanisms read); doc 03 span/
event wire schema (`ts: string` on `Base` — this doc supplies the value); doc 05 timeouts/
backpressure knobs (narrow this doc's config, don't re-declare precedence); doc 09 write-safety
ledger (`write.attempting`/`write.committed` timestamps — this doc's Clock, doc 09's events).

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
Every timestamp in the rebuilt system — span `ts`, checkpoint `captured_at`, trace-id time-of-day,
write-safety ledger events (doc 09), fiscal-year lookups — reads through it.

```ts
// temp_src/domain/clock.ts — the ONLY file in temp_src allowed to call new Date()/Date.now()
export interface Clock {
  /** Current instant. Every other Clock method is derived from this — never a second OS read. */
  now(): Date;
  nowMs(): number;
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
  todayLocal() { return localDatePart(this.now()); },
  timeOfDayCode(at = this.now()) { return formatTraceTimestamp(at); },  // ported from queue-trace-id.ts
  fiscalYear(at = this.now()) { return at.getMonth() >= 6 ? at.getFullYear() + 1 : at.getFullYear(); },
};

/** Deterministic test Clock — every method derives from the one frozen instant. */
export function fixedClock(at: Date): Clock { /* same shape, `now()` always returns `at` */ }
```

**Composition with existing contracts (nothing else changes shape — only the `now` input):**

- **Doc 02 §5.5 freshness walk (D8).** `now − captured_at > maxAgeMs` reads `clock.now()`. This
  makes the freshness *safety* computation unit-testable for the first time — a `fixedClock` test
  can assert the exact boundary (`maxAgeMs` exactly exceeded vs. not) without waiting real time.
- **Doc 03 spans.** The executor holds one `Clock` instance; every `SpanEvent.ts` (`Base.ts: string`
  in doc 03 §2) is `clock.now().toISOString()`, stamped once at emission, never re-derived.
- **Trace ids.** `buildTraceId({ code, runId, at: clock.now() })` — the function itself
  (`queue-trace-id.ts`) ports verbatim (it was already pure); only the caller changes from
  `at: new Date()` to `at: clock.now()`.
- **Doc 09 write-safety ledger.** `write.attempting`/`write.committed` timestamps and the crash-
  window fence read `clock.now()` — same executor-held instance as spans, so a fence and its span
  are never timestamped by two different clock reads.
- **Checkpoint `captured_at`** (doc 02 §5.7) — `clock.now().toISOString()` at checkpoint write.

**The guard (registered in doc 10's guard-of-guards manifest):**
`tests/unit/architecture/clock-single-source.test.ts` — bans `new Date(` / `Date.now(` anywhere in
`temp_src/**` **except** `temp_src/domain/clock.ts`, using the same `Record<file,{count,reason}>`
shrink-only-allowlist mechanism as `wait-for-timeout-allowlist.test.ts`: a **ported leaf** (e.g. a
verbatim-ported selector helper with an inline timestamp) may carry a shrinking allowlist entry;
**new `temp_src` code gets zero tolerance.** A second guard, `fixed-clock-test-only.test.ts`, bans
importing `fixedClock` outside `*.test.ts` / `tests/**` — a `fixedClock` import in production code
is a symptom of accidentally wiring the test double into a real executor.

---

## 3. Config resolver

**One resolver function implements `env > settings.json > default` exactly once.** Every current
read site's inline `process.env.X ?? SETTINGS.y.z ?? literal` expression is replaced by a call into
this resolver; the precedence logic itself is never repeated.

```ts
// temp_src/domain/config/schema.ts — the ONE place defaults live (kills the config.ts ↔
// DEFAULT_OPERATOR_SETTINGS duplication the gap audit flagged at types.ts:226)
export const ConfigSchema = z.object({
  urls: z.object({
    kualiSpace: z.string().url().default("https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb"),
    newKronos: z.string().url().default("https://ucsd-sso.prd.mykronos.com/wfd/home"),
    crmEntry: z.string().url().default("https://crm.ucsd.edu/hr"),
    onbase: z.string().url().default("https://ucsd.hylandcloud.com/251ids/NavPanel.aspx"),
    crmSearch: z.string().url().default("https://act-crm.my.site.com/hr/ONB_SearchOnboardings"),
    ucpathSmartHr: z.string().url().default(/* the long UCPath deep-link literal, ported verbatim */ ""),
    i9: z.string().url().default("https://i9complete.ucop.edu"),
    i9App: z.string().url().default("https://wwwe.i9complete.com"),      // was escaping the schema (I9_APP_URL)
    ukg: z.string().url().default("https://ucsd.kronos.net/wfcstatic/..."),
    crmSections: z.record(z.string().url()).default({                    // was escaping the schema (CRM_SECTION_URLS)
      "UCPath Entry Sheet": "https://act-crm.my.site.com/hr/ONB_PPSEntrySheet",
      "Onboarding History": "https://act-crm.my.site.com/hr/ONB_ShowOnboardingHistory",
    }),
  }).strict(),
  timeouts: z.object({ navigationMs: z.number().int().positive().default(15_000), /* … */ }).strict(),
  paths: z.object({ reportsDir: z.string().default(""), /* … */ }).strict(),
  /** Keyed by fiscal year ("FY2027"), NOT a flat literal — see §5. */
  annualDates: z.record(z.string().regex(/^FY\d{4}$/), AnnualDateEntrySchema).default({}),
  operator: z.object({ timekeeperName: z.string().default("") }).strict(),
  // … capture / browserHealth / concurrency / daemon / ocr / features: ported 1:1 from
  // domain/settings/types.ts, unchanged shape, now zod-typed instead of a hand-written interface.
}).strict();
export type Config = z.infer<typeof ConfigSchema>;
```

```ts
// temp_src/domain/config/resolve.ts
/** One declarative table replaces every scattered `process.env.X ?? …` read site. */
const ENV_KEY_MAP: Record<string, string> = {
  "urls.kualiSpace": "KUALI_SPACE_URL_OVERRIDE",     // rare — URLs are normally settings-driven, not env
  "annualDates.*.jobEndDate": "ANNUAL_DATES_END",     // resolved against the CURRENT fiscal year only
  "annualDates.*.kronosDefaultEndDate": "KRONOS_DEFAULT_END_DATE",
  "annualDates.*.kronosDefaultStartDate": "KRONOS_DEFAULT_START_DATE",
  "operator.timekeeperName": "TIMEKEEPER_NAME",
  "ocr.secondOpinionMax": "OCR_SECOND_OPINION_MAX",
  // … every OperatorSettingsOverride ↔ env-var pair from applyOperatorSettingsEnv, ported verbatim
};

export function resolveConfig(env: NodeJS.ProcessEnv, settingsOverride: unknown): Config {
  const withDefaults = ConfigSchema.parse({});                 // zod .default() fills every leaf — ONE source
  const withSettings = deepMergeNonEmpty(withDefaults, SettingsOverrideSchema.parse(settingsOverride ?? {}));
  const withEnv = applyEnvPrecedence(withSettings, ENV_KEY_MAP, env);  // explicit env wins, treats "" as unset
  return ConfigSchema.parse(withEnv);                           // final validation — a bad env/settings value throws here
}
```

- **"Empty settings = today's behavior" invariant, structurally guaranteed, not hand-maintained.**
  Because the defaults live in exactly one place (the zod schema's `.default()`s), there is no
  second literal to drift out of sync — the duplication `types.ts:226`'s comment currently warns
  about cannot recur. `resolveConfig(process.env, {})` reproduces the schema defaults by
  construction. A `config-schema-snapshot.test.ts` still pins the literal default *values*
  themselves (so an accidental edit to a default URL/timeout is caught in review, same spirit as
  today's mirrored-literal safety net, but with one source instead of two).
- **Workflow/system configs narrow, they never redeclare.** `temp_src/stores/ucpath/config.ts`
  reads `const { ucpathSmartHr } = resolveConfig(...).urls;` — a thin selector over the one
  resolved `Config`, never its own `env > settings > default` expression. This directly closes gap
  #4's "precedence re-implemented per read-site" finding.
- **Effective value + source, surfaced.** The resolver returns `{ value, source: "env" |
  "settings" | "default" }` per leaf (not just the merged value) so Settings can keep showing the
  read-only transparency the old dashboard already has (`.env` Credentials panel) — this is what
  closes the "precedence-shadowing" risk (§7).

---

## 4. Per-run test-vs-production instance selection — **scope-optional-now**

The charter defers this (operator directive: process-global URL override is today's accepted
behavior); this section **designs** the mechanism so it exists as an approved shape when a workflow
genuinely needs mixed prod/test targeting, without building it in Phase 1/2.

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
  instance?: Partial<Record<SystemId, "prod" | "test">>;
}
```

- **Loud default, never silent.** Omitting `instance` (the common case — every run today) resolves
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
- **Recorded in the audit trail.** `RunQueued.instance` (doc 03's span schema) carries the resolved
  map (even when empty/all-prod) — so every run's actual target, per system, is queryable from the
  ledger (gap-audit gap 5), not inferred.
- **Recommendation: defer.** Adopt when a workflow needs concurrent mixed targeting — e.g.
  validating a new Kuali/OnBase task against a sandbox instance while production runs of other
  workflows continue on the same executor. Until two runs need *different* targets *at the same
  time*, the existing process-global `SETTINGS.urls.*` override (start the daemon once against a
  test instance, once against prod) is simpler and already ported. The design above is what to
  build the day that changes — it is a RunEnvelope field + one resolver function, not a new
  subsystem, so adopting it later is cheap.

---

## 5. Fiscal-year dates — fail-loud, not silently stale

Today's `ANNUAL_DATES` is a flat, single-year literal that has no rollover mechanism and is already
past due (`jobEndDate: "06/30/2026"`, today 2026-07-18). The rebuild makes staleness a **loud
failure at the point of use**, not a silently-wrong fill.

- **Keyed by fiscal year, not flat.** `Config.annualDates: Record<"FY${number}", AnnualDateEntry>`
  (§3's schema). There is no single "the" `jobEndDate` — there is `annualDates["FY2027"]
  .jobEndDate`, looked up by the Clock.
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

One typed accessor is the sole home for every credential — `.env` vars, the `.auth/` Duo private
key file, and the LAN dashboard password — replacing `validateEnv()` + `getTimekeeperName()` + ~20
files' inline `process.env.*` reads with one surface.

```ts
// temp_src/domain/secrets.ts
interface SecretSpec { env: string; required: boolean }

const SECRETS = {
  ucpathUserId:      { env: "UCPATH_USER_ID", required: true },
  ucpathPassword:     { env: "UCPATH_PASSWORD", required: true },
  timekeeperName:     { env: "TIMEKEEPER_NAME", required: false },  // lazy-required — see below
  dashboardLanPassword: { env: "HRAUTO_DASHBOARD_LAN_PASSWORD", required: false },
} as const;
type SecretName = keyof typeof SECRETS;

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

/** File secrets (the .auth/ Duo credential) — distinguishes "missing" from a generic ENOENT. */
export function requireSecretFile(path: string): Buffer { /* … */ }
```

- **Fail-loud at startup, ported pattern.** `validateRequiredSecrets()` runs once at daemon/
  dashboard boot (successor to today's `validateEnv()` call), throwing with every missing var named
  at once — not one at a time across three separate run failures.
- **Never logged.** The accessor is the only function permitted to read a secret's raw value; every
  other module receives it as an opaque string to hand to a login/fill call, never to `log.*`. A
  grep-ratchet guard (below) backstops this structurally.
- **`.auth/` and Duo credentials get one owned home.** `requireSecretFile(DUO_WEBAUTHN_CREDENTIAL_
  PATH)` replaces the direct `readFileSync` in `infra/auth/duo-webauthn.ts:1` — the cross-process
  lock and signCount-reservation logic (live-verified, ported verbatim per the charter) stay
  exactly as they are; only the raw-file-read call site changes to go through this accessor.

**The guard:** `secrets-single-source.test.ts` — bans `process.env.` outside `domain/secrets.ts`
and `domain/config/` (the config resolver's own env-precedence reads are a distinct, permitted
concern from secret *values*; the guard's allowlist distinguishes a config *URL* env read from a
*credential* env read by the `SECRETS`/`ENV_KEY_MAP` table membership). `no-secret-values-in-logs.
test.ts` — a grep-ratchet flagging `log.*`/template-literal interpolation of identifiers named
`password`/`privateKey`/`credential`/`secret` (case-insensitive), same `Record<file,{count,reason}>`
shape as the existing ratchets, catching an accidental `log.info(`login as ${password}`)`.

---

## 7. Adversarial self-review

| Vector | Risk | Guard |
|---|---|---|
| A config default masks a genuinely missing value (empty URL silently = production) | An operator who *meant* to set a test URL, typo'd it empty, unknowingly runs against production | This is the charter's "verified + genuinely valid" exception, not a masked failure: empty-URL-means-production is a **documented, verified** default (every URL's production literal is the live-verified value already in `config.ts` today) — not a guess. What closes the *dangerous* half (test intended, prod delivered) is §4's fail-loud instance-selection check, which is orthogonal to and stricter than the plain config default |
| Stale fiscal-date fallback | A rollover is missed; last year's date silently reused | §5: missing-FY throws; existing-but-past-due entry ALSO throws (`assertNotPast`) — closes both the "nobody rolled it over" and "somebody rolled it over wrong" cases |
| Clock skew (host OS clock is wrong) | Freshness comparisons (D8) and trace-id time-of-day become wrong in lockstep, undetectably | **Residual, not fully closed** — both `captured_at` and the freshness check's `now` read the SAME `Clock`, so a *constant* OS skew cancels out in the `now − captured_at` subtraction; a skew that *changes* between capture and check (e.g. host clock stepped by NTP mid-run) is a genuine gap. Recommend (not built here): log a skew warning if the OS clock jumps backward or by a large delta between two `systemClock.now()` reads in the same process — a cheap monotonic-vs-wall-clock sanity check, out of scope for this doc |
| `fixedClock` (test double) leaks into a production executor | A daemon silently runs with a frozen clock — every trace id, span, and freshness check wrong in the same way, all at once, no crash | `fixed-clock-test-only.test.ts` — import-site guard, `fixedClock` only importable from `*.test.ts`/`tests/**` |
| `ENV_KEY_MAP` typo (env var name misspelled, or a schema leaf added without a matching env entry) | An operator sets an env var that silently does nothing (the resolver never looks for it) | `config-env-map-coverage.test.ts` — asserts every schema leaf marked `envBacked` in a leaf-level annotation has exactly one `ENV_KEY_MAP` entry, and every `ENV_KEY_MAP` entry resolves to a real schema path (bidirectional coverage, same shape as the existing registry-parity guards) |
| Per-run instance selection (§4) becomes the THIRD `??`-chain nobody audits | Design rot before it's even built | Marked explicitly scope-optional-now; the recommendation names the exact adoption trigger (concurrent mixed targeting) so it isn't built speculatively and isn't forgotten either — it's one `RunEnvelope` field + one resolver function away, not a parallel subsystem to maintain unused |

---

## 8. Worked example

**A live onboarding hire-date fill against production, everything resolved from its one source:**

```ts
const clock = systemClock;
const config = resolveConfig(process.env, readOperatorSettingsOverride());
validateRequiredSecrets();                                    // throws loud if UCPATH_USER_ID/PASSWORD unset

const runId = crypto.randomUUID();
const traceId = buildTraceId({ code: "ou", runId, at: clock.now() });   // §2 — Clock supplies `at`

const ucpathUrl = resolveSystemUrl(config, "ucpath", envelope.instance?.ucpath ?? "prod");  // §4 — loud default = prod
// envelope.instance is absent here → "prod" → production literal, exactly as today

const annualDates = requireAnnualDates(config, clock);         // §5 — FY2027 entry, not past-due; else throws
const ucpathPassword = requireSecret("ucpathPassword");        // §6 — throws loud if unset, never logged

// … task runs, checkpoints written with captured_at: clock.now().toISOString() (§2/§3 composition) …
// span.ended(run, "done") — RunQueued.instance = {} (all-prod, recorded per §4)
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

## 9. Open questions

1. **`SECRETS`/descriptor-declared secret requirements (§6).** Should a workflow descriptor
   formally declare `requires: SecretName[]` (checked at enqueue, like session needs), or is a
   lazy per-task `requireSecret()` call sufficient? The lazy form matches today's
   `getTimekeeperName()` pattern but defers the failure later than necessary.
2. **Clock-skew detection (§7).** Worth a cheap monotonic-vs-wall sanity probe in the executor, or
   accept it as a residual, documented risk given real hosts rarely skew mid-run?
3. **`ENV_KEY_MAP` for URLs.** Today's `config.ts` has almost no URL env-var overrides (URLs are
   settings-driven, not env-driven) — should the rebuild keep that asymmetry (URLs: settings only;
   timeouts/OCR/etc.: settings + env), or make every config leaf uniformly env-overridable for
   consistency?
4. **Fiscal-year entry authoring UI.** `annualDates` keyed by `FY${year}` needs an operator-facing
   place to add next year's entry (Settings page) — is that in this doc's scope or doc 03's
   dashboard-flip scope (D13 says Settings proxies to old endpoints until its own migration
   milestone)?
5. **Per-run instance selection's actual trigger (§4).** Is there a concretely planned workflow
   (e.g. a Kuali/OnBase sandbox validation pass) that will need it soon, which would argue for
   building it in Phase 2 rather than deferring — or is it genuinely speculative until further
   notice?
