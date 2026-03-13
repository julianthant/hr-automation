# Project Research Summary

**Project:** UCPath HR Browser Automation (PeopleSoft + Salesforce + SSO/Duo MFA)
**Domain:** HR RPA / Cross-application browser automation
**Researched:** 2026-03-13
**Confidence:** HIGH

## Executive Summary

This project is an RPA-style CLI tool that automates the transfer of employee onboarding data from a Salesforce-based ACT CRM portal into UCPath (PeopleSoft), bypassing repetitive manual data entry by UCSD HR staff. The expert approach is to build a Playwright-driven browser automation tool using the Page Object Model pattern, with a typed data pipeline (Zod validation) separating the scrape side from the entry side. The tool is emphatically not a web service or a headless bot — it must run on the user's machine, with a visible browser, because Duo MFA requires human approval that cannot be circumvented.

The recommended implementation is a Node.js 22 + TypeScript 5.7 CLI using `playwright` (library mode, not test runner), Commander for argument parsing, Zod for schema validation, and Winston for structured logging. The architecture separates cleanly into four layers: CLI entry, workflow orchestrator, page objects (one class per target screen), and a data validation layer. Each layer has a single responsibility, and the Zod schema between scrape and entry is the critical data contract that prevents unvalidated PII from entering UCPath forms.

The principal risks are: (1) entering wrong or duplicate data into UCPath's payroll system, which has no undo and requires manual UCPC intervention to correct; (2) PII leaking into log files, screenshots, or git history; and (3) brittle selectors breaking when PeopleSoft or Salesforce updates their UI. These risks are mitigated by a mandatory dry-run mode before any real submission, strict in-memory-only data handling (no PII to disk), and a Page Object Model with selector abstraction centralized in configuration. The tool must be designed around these constraints from Phase 1 — retrofitting them is both harder and riskier.

## Key Findings

### Recommended Stack

Playwright 1.58.x is the clear choice for this project — it provides native `FrameLocator` for PeopleSoft's iframe structure, native Shadow DOM piercing for Salesforce Lightning components, persistent browser context for SSO session reuse, and `page.pause()` as a clean Duo MFA interrupt point. There is no case for Selenium (more complexity, worse iframe handling) or Puppeteer (Chromium-only, no FrameLocator) on a greenfield 2026 project. The tool must run in headed mode (`headless: false`) — non-negotiable due to Duo MFA.

The TypeScript + tsx stack is the right call: type safety catches field mapping errors between ACT CRM fields and UCPath form inputs at compile time, and Zod schemas provide runtime validation of scraped employee data with `z.infer<>` type extraction. `tsx` replaces both `ts-node` and `nodemon` with faster esbuild-based transpilation. Logging goes through Winston (human-readable output for HR staff) rather than Pino (JSON-only, performance advantage irrelevant at this scale).

**Core technologies:**
- **Playwright 1.58.x**: Browser automation — only tool with both FrameLocator (PeopleSoft iframes) and Shadow DOM piercing (Salesforce Lightning) in a single API
- **Node.js 22 LTS**: Runtime — supported through April 2027, native `--env-file` flag, required by Playwright
- **TypeScript 5.7**: Language — type-safe field mapping between scraped data and form inputs; catches mismatches at compile time
- **tsx 4.x**: TypeScript execution — esbuild-based, faster than ts-node, better ESM support, `--watch` mode included
- **Zod 3.x**: Data validation — defines employee schema, validates scraped data before form entry, exports TypeScript types via `z.infer<>`
- **Commander 14.x**: CLI framework — argument parsing, subcommands (`run`, `dry-run`, `test-login`), `--help` generation
- **Winston 3.x**: Logging — console + file transports, human-readable output, audit trail per run
- **csv-parse 5.x**: CSV input parsing — Node.js-native streaming parser for batch employee email lists

### Expected Features

The feature research identifies three clear tiers. The foundation layer (authentication, session management, resilient selectors, credential security) must be rock-solid before anything else is built — every other feature depends on these. The core value layer (scraping ACT CRM, entering UCPath, input validation, logging) is what makes the tool useful. The reliability layer (batch processing, error isolation, retry logic, progress reporting) is what makes it trustworthy for daily HR use.

**Must have (table stakes):**
- SSO + Duo MFA-aware login — without this the tool does nothing; must pause for manual Duo approval
- Cross-system session management — single browser context authenticating across both UCPath and ACT CRM
- Data extraction from ACT CRM portal — scrape position number, names, SSN, address, wage, effective date
- Data entry into UCPath Smart HR Transactions — UC_FULL_HIRE template selection, effective date, create transaction
- Batch processing — accept multiple employee emails, process sequentially (never parallel — PeopleSoft locks)
- Per-employee error isolation — one failed employee must not abort the remaining batch
- Structured logging and run reports — audit trail of what was processed, what failed, what needs follow-up
- Credential security — PII never to disk, `.env` for credentials, `.gitignore` blocks secrets from day one
- Input validation before processing — catch bad data before touching UCPath forms
- Resilient element selection — abstracted selector layer, no dynamic IDs, central config for selectors

**Should have (differentiators):**
- Dry-run / preview mode — show what would be entered before actually submitting; critical given no-undo nature of UCPath transactions
- Configuration-driven field mapping — selectors and field mappings in config, not hardcoded; isolates UI changes to config updates
- Session persistence across runs — `storageState` to survive re-auth between batches on the same day
- Smart retry with backoff — handle PeopleSoft's known flakiness without killing the employee's transaction
- Screenshot on failure — capture browser state at failure point for post-mortem debugging
- Progress reporting — per-employee status lines during batch runs
- Data verification checkpoints — read back filled form values before submission; abort on mismatch
- Selective re-processing — `--retry-failed` flag reads last run's JSON results and reprocesses only failures

**Defer (v2+):**
- Full UC_FULL_HIRE form field automation (beyond template selection and effective date)
- Web UI / dashboard — CLI is sufficient for this user base
- Email/Slack notifications — operators are present during runs
- Support for additional Smart HR templates beyond UC_FULL_HIRE
- Scheduling / cron runs — conflicts with Duo MFA pause requirement
- Parallel browser instances — PeopleSoft doesn't support concurrent sessions from the same context

### Architecture Approach

The architecture follows a strict four-layer separation: CLI entry (Commander, thin — no business logic), Workflow Orchestrator (sequences auth, scrape, and entry steps; owns per-employee error boundaries), Page Objects (one class per target screen, all selectors encapsulated here), and a Data Layer (Zod schemas, validators, transformers). The Zod employee schema is the architectural contract between the scrape side and the entry side — scraped data must pass schema validation before the entry side ever touches it. A single Playwright persistent browser context runs throughout the batch, carrying SSO cookies across both target systems.

**Major components:**
1. **CLI Entry** (`src/cli/`) — Commander subcommands (`run`, `dry-run`, `test-login`); parses args, calls orchestrator; zero business logic
2. **Workflow Orchestrator** (`src/orchestrator/`) — sequences the pipeline (auth, scrape, validate, enter); wraps each employee in try/catch; owns batch result accumulation
3. **Page Objects** (`src/pages/`) — `sso-login.page.ts`, `act-crm/portal.page.ts`, `act-crm/entry-sheet.page.ts`, `ucpath/navigation.page.ts`, `ucpath/smart-hr.page.ts`; all selectors live here
4. **Data Layer** (`src/data/`) — Zod employee schema, validators, field transformers; the contract between scrape and entry
5. **Browser Context** (`src/browser/`) — Playwright launch, persistent context, session save/restore; isolated from business logic
6. **Logging / Audit** (`src/logging/`) — Winston setup, per-employee result recording to JSON; never logs PII

### Critical Pitfalls

1. **PeopleSoft postback stale elements** — Every dropdown selection or form interaction triggers a full server-side DOM replacement inside the iframe. Never cache element references; always re-locate immediately before each interaction. Build this into the base interaction helpers from day one — retrofitting is painful.

2. **PII leaking into logs, screenshots, and error messages** — Playwright captures page content in traces, screenshots on failure, and console logs. SSNs and employee PII must never appear in any log output, error message, or captured state. Log field names and status only (`"SSN: OK"`). Mask SSNs in any display (`***-**-1234`). Establish `.gitignore` and PII-safe logging conventions before writing any PII-touching code.

3. **Creating duplicate or uncorrectable UCPath transactions** — UCPath Smart HR Transactions are real payroll records with no undo. If the batch re-runs a processed employee, it creates a duplicate. If a selector targets the wrong employee row, wrong data enters payroll. Implement: idempotency tracking (log of processed emails), data readback verification (read filled form values before submit), and dry-run mode. Never retry the submit button.

4. **Cross-domain SSO session assumption** — UCPath and ACT CRM both use UCSD SSO but may require separate auth handshakes (different service providers). Test both systems in a clean Playwright context early. Design auth as two independent modules, each capable of handling a full SSO + Duo MFA cycle. Do not assume a UCPath session automatically authenticates ACT CRM until proven in the actual automation browser.

5. **Duo MFA pause logic that breaks session flow** — Duo involves multiple redirects. A naive `waitForTimeout` or URL-change wait triggers false positives on intermediate redirects. Wait for a definitive post-auth element (PeopleSoft homepage content, Salesforce page layout), with a generous 90-120 second timeout. Handle denial and timeout cases explicitly — the script must not hang or cascade into cryptic errors.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation and Authentication
**Rationale:** Every other feature depends on being able to launch a browser, authenticate through UCSD SSO + Duo MFA, and reach both target systems in an authenticated state. PeopleSoft's iframe structure and the MFA pause gate must be solved before any productive work can be done. PII protections and `.gitignore` conventions must also be established before any employee data is handled — retrofitting these is risky. Five of the eight critical pitfalls (postback handling, iframe targeting, PII logging, Duo MFA logic, cross-domain session) must be addressed here.
**Delivers:** Working, authenticated browser session reaching both UCPath and ACT CRM; proven Duo MFA pause flow; project structure with PII-safe logging conventions; `test-login` CLI command.
**Addresses features:** SSO + MFA-aware login, cross-system session management, credential security, resilient element selection layer
**Avoids pitfalls:** Duo MFA session flow breakage, cross-domain session assumption, PII leaking into logs, PeopleSoft iframe targeting, PeopleSoft navigation timing

### Phase 2: Core Data Pipeline (Single Employee)
**Rationale:** Once authenticated, build the full scrape-validate-enter pipeline for a single employee end-to-end. This is where the core value of the tool is delivered. The Zod schema (data contract between scrape and entry) must be established here. Dry-run mode is not optional for Phase 2 — given the no-undo nature of UCPath transactions, operators need to verify data before real submissions are enabled. Idempotency tracking and data readback verification must also land here before any real UCPath submissions happen.
**Delivers:** End-to-end single-employee processing: scrape from ACT CRM, validate with Zod, enter into UCPath Smart HR transaction; `dry-run` CLI command; idempotency log.
**Uses:** Playwright FrameLocator (PeopleSoft iframes), Playwright Shadow DOM piercing (Salesforce Lightning), Zod schema for employee data
**Implements:** ACT CRM page objects, UCPath page objects, employee schema, data validation layer
**Avoids pitfalls:** Duplicate/incorrect UCPath transactions (dry-run + data readback + idempotency), PeopleSoft dynamic element IDs (selector map established), no-validation anti-pattern (Zod safeParse gate)

### Phase 3: Batch Processing and Reliability
**Rationale:** With the single-employee pipeline proven, extend to batch processing. This phase delivers the primary time-saving value for HR staff. Per-employee error isolation is mandatory — one bad record must not kill the remaining nine. Smart retry, progress reporting, and screenshot-on-failure round out the reliability story. Session timeout detection (PeopleSoft times out after 20-30 min) must be handled here or large batches will fail mid-run.
**Delivers:** Multi-employee batch runs with per-employee error isolation; `--retry-failed` flag; progress reporting; screenshot on failure; PeopleSoft session timeout detection and re-auth.
**Implements:** Orchestrator batch loop, per-employee try/catch boundaries, Winston audit log (JSON per run), session management helpers
**Avoids pitfalls:** Session timeout mid-batch, silent failure propagation, no progress indication UX pitfall

### Phase 4: Hardening and Operator Experience
**Rationale:** With the full pipeline working, layer in the features that increase trust and long-term maintainability: configuration-driven field mapping (isolates UI changes to config), session persistence across runs (reduces daily MFA friction), headless mode toggle, and final UX polish. This is also when selector maps should be extracted to configuration if not already done.
**Delivers:** Config-driven field/selector mapping; `storageState`-based session persistence; `--headless` flag; polished terminal output and run summaries; `.env.example` documentation.
**Uses:** Zod for config validation, Playwright `storageState` for session persistence
**Implements:** Config layer, session save/restore helpers, final CLI UX

### Phase Ordering Rationale

- **Auth before data:** There is zero value in building scrape or entry logic if the tool cannot authenticate. Auth is the literal gate to both systems.
- **Single employee before batch:** Validating the pipeline end-to-end for one employee is the only safe way to verify correctness before batch logic multiplies the opportunity for errors. Batch processing on an unproven pipeline risks creating multiple corrupted UCPath records.
- **Dry-run in Phase 2 (not deferred):** Given the no-undo severity of UCPath transactions, dry-run mode should be available before any real submissions happen. FEATURES.md lists it as "defer," but PITFALLS.md establishes it as a table-stakes safety control for the entry phase. Resolution: build it alongside Phase 2.
- **Config-driven mapping last:** Hardcoded selectors are faster to develop initially and appropriate for the first working pipeline. Extracting to config is a Phase 4 maintainability investment once the selector set is known and stable.
- **Sequential processing always:** Parallel browser instances are explicitly listed as an anti-feature. PeopleSoft stateful sessions do not support concurrent form entry. This is not a Phase N decision — it is an architectural constant.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1 (authentication):** The actual SSO redirect flow and whether ACT CRM requires a second Duo MFA prompt is unknown until tested in a real Playwright browser context. Research should include a live authentication test session before coding the auth module. Pitfall 6 (cross-domain session assumption) is explicitly flagged as "verify empirically."
- **Phase 2 (ACT CRM scraping):** The ACT CRM portal is a Salesforce community site (`*.my.site.com`), which may use a simpler DOM than full Lightning Experience. Actual selectors cannot be determined without a live session. The `npx playwright codegen` step must be part of Phase 2 planning.
- **Phase 2 (UCPath form entry):** The specific element IDs and field sequence for the UC_FULL_HIRE template in UCPath require live inspection. PITFALLS.md recommends manually cataloging the selector map before coding. This is a research task within Phase 2.

Phases with standard patterns (skip research-phase):
- **Phase 3 (batch processing):** The per-employee try/catch pattern, idempotency log, and Winston audit trail are well-documented patterns with no system-specific unknowns. Architecture research provides clear implementation guidance.
- **Phase 4 (hardening):** Playwright `storageState`, Commander CLI flags, and config file patterns are all well-documented with no ambiguity.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core technology choices verified against official docs (Playwright, tsx, Zod, Commander). Version compatibility cross-checked. Alternatives clearly evaluated. |
| Features | HIGH | Feature tiers derived from multiple RPA/HR automation sources plus UCSD UCPath-specific documentation. Anti-features are well-reasoned against project constraints. |
| Architecture | HIGH | Page Object Model + pipeline orchestrator is the established pattern for browser automation. Component boundaries are clear and derived from dependency analysis, not guesswork. |
| Pitfalls | HIGH (PeopleSoft/SSO/PII), MEDIUM (Salesforce portal specifics) | PeopleSoft iframe and postback pitfalls are verified via real-world automation projects. Salesforce community portal specifics require live testing to confirm — the portal may differ from full Lightning Experience. |

**Overall confidence:** HIGH

### Gaps to Address

- **ACT CRM portal DOM structure:** The actual HTML/shadow DOM structure of the Salesforce community portal that hosts onboarding data is unknown without a live authenticated session. Selectors cannot be determined in advance. Plan a selector discovery sprint using `npx playwright codegen` early in Phase 2.
- **UCPath UC_FULL_HIRE field IDs:** The specific element IDs for the UC_FULL_HIRE template must be cataloged by inspecting the live UCPath page. PITFALLS.md recommends building a selector map as a configuration file. This is a mandatory early step in Phase 2, not a later refinement.
- **Cross-domain SSO behavior:** Whether a single UCSD SSO login authenticates both UCPath and ACT CRM in the same Playwright context is an empirical question. May require two separate Duo approvals per session. Design the auth module for the two-prompt case and confirm actual behavior during Phase 1 development.
- **PeopleSoft session timeout duration:** UCPath's specific session timeout threshold (estimated 20-30 minutes per PITFALLS.md sources) must be confirmed. Affects how large a batch can be processed before a re-authentication event is needed.

## Sources

### Primary (HIGH confidence)
- [playwright.dev/docs](https://playwright.dev/docs) — FrameLocator, auth/storageState, persistent context, release notes (v1.58.x)
- [zod.dev](https://zod.dev/) — schema validation, z.infer type extraction
- [tsx.is](https://tsx.is/) — esbuild-based TypeScript runner documentation
- [Commander.js GitHub](https://github.com/tj/commander.js) — CLI framework v14 API
- [UCSD UCPath Smart HR Job Aids](https://ucpath.ucsd.edu/transactors/ucpath-job-aids/smart-hr.html) — UC_FULL_HIRE template workflow
- [Oracle PeopleSoft Portal Technologies](https://docs.oracle.com/cd/E24150_01/pt851h2/eng/psbooks/tprt/htm/tprt12.htm) — `ptifrmtgtframe` iframe architecture
- [npm: playwright](https://www.npmjs.com/package/playwright) — v1.58.x confirmed current stable
- [NIST SP 800-122](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-122.pdf) — PII handling guidelines

### Secondary (MEDIUM confidence)
- [Peoplesoft HTML Element IDs](https://peoplesoftmods.com/tips-and-tricks/peoplesoft-html-element-ids/) — `RECORDNAME_FIELDNAME` ID convention (undocumented by Oracle)
- [Salesforce Test Automation with Playwright - TestRig](https://www.testrigtechnologies.com/salesforce-test-automation-with-playwright-challenges-setup-and-proven-strategies/) — Shadow DOM and Lightning component patterns
- [Gearset: Salesforce UI Testing Challenges](https://gearset.com/blog/salesforce-ui-testing-challenges/) — dynamic IDs, data-test attributes
- [BrowserStack: Playwright Persistent Context](https://www.browserstack.com/guide/playwright-persistent-context) — session management patterns
- [Pino vs Winston - Better Stack](https://betterstack.com/community/guides/scaling-nodejs/pino-vs-winston/) — logging library comparison
- [tbensky/selenium-peoplesoft](https://github.com/tbensky/selenium-peoplesoft) — real-world PeopleSoft automation, iframe/timing/XPath challenges
- [Elio Struyf: E2E Testing with Playwright Auth Session](https://www.eliostruyf.com/e2e-testing-mfa-environment-playwright-auth-session/) — MFA session handling

### Tertiary (LOW confidence — needs validation in live environment)
- ACT CRM portal DOM structure — unknown until live authenticated session; `codegen` session required
- UCPath UC_FULL_HIRE template element IDs — requires live UCPath inspection; cannot be researched without access
- Cross-domain SSO behavior — whether one Duo prompt or two is required is empirical; must test in clean Playwright context

---
*Research completed: 2026-03-13*
*Ready for roadmap: yes*
