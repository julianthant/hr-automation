# Phase 1: Authentication and Project Foundation - Research

**Researched:** 2026-03-13
**Domain:** Browser automation, SSO authentication, TypeScript project scaffolding
**Confidence:** HIGH (core stack) / MEDIUM (SSO selectors -- require live discovery)

## Summary

Phase 1 establishes a TypeScript + Playwright project that authenticates into two UCSD systems (UCPath and ACT CRM) through Shibboleth SSO with Duo MFA. The core challenge is not the technology stack -- Playwright is the clear standard for this -- but the MFA pause pattern (automation must yield to a human for Duo approval) and the unknown SSO/login page selectors that can only be discovered empirically against the live sites.

Playwright (v1.58) as a library (not test runner) provides everything needed: `storageState` for session persistence, `waitForSelector`/`waitForURL` for login detection, and headed Chromium for the visible browser Duo requires. The project scaffolds as a TypeScript CLI using `tsx` for execution, `commander` for argument parsing, and Node.js native `--env-file` for credential loading (no dotenv dependency needed on Node v22).

**Primary recommendation:** Use Playwright as a library with `storageState`-based session persistence, Chromium browser, and a polling loop for Duo MFA detection. Keep the project lean -- no test runner framework, no heavy logging library. Console output with `picocolors` for the CLI status messages.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **MFA Pause Behavior:** Console message notification only ("Waiting for Duo approval...") -- no OS notifications or browser focus tricks. 15-second timeout for Duo approval. On timeout: retry once (another 15s window), then exit with clear error. ACT CRM separate login (if needed) handled silently -- auto-detect login page, select "Active Directory", enter same credentials, wait for Duo if required.
- **Session Persistence:** Save browser state (cookies/storage) to `.auth/` directory in project root. `.auth/` added to `.gitignore` -- never committed. On stale/expired session: silently clear and fall back to full login flow (no user prompt). `--fresh` CLI flag to force fresh login (ignores saved session).
- **CLI Output Style:** Step-by-step status messages at key milestones: "Navigating to UCPath...", "Login page loaded", "Waiting for Duo...", "Authenticated". Brief summary at end: show auth status for both systems and session save confirmation. Colors + symbols throughout: green checkmark for success, yellow hourglass for waiting, red X for errors. Never show PII in terminal output -- no username, email, or credentials displayed. Just "Entering credentials..."
- **Auth Failure Recovery:** Wrong password / SSO error: exit immediately with specific error message. Browser crash / page load failure: retry once (close and relaunch browser), then exit with error. Validate `.env` has all required fields (USERNAME, PASSWORD) at startup before launching browser -- fail early with message listing what's missing. Close browser after successful test-login (session is saved to `.auth/`).

### Claude's Discretion
- Project scaffolding structure (TypeScript config, folder layout, package manager)
- Playwright browser choice and configuration
- Exact selector strategies for PeopleSoft/SSO pages
- Session detection mechanism (how to determine if already logged in)
- Internal error handling and logging implementation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUTH-01 | User can launch browser and navigate to UCPath login page (ucpath.ucsd.edu) | Playwright `chromium.launch()` + `page.goto()` -- see Standard Stack and Code Examples |
| AUTH-02 | Automation clicks "Log in to UCPath", selects UC San Diego, and enters stored credentials | Playwright locators (`page.click()`, `page.fill()`) + .env credential loading -- see Architecture Patterns and Code Examples |
| AUTH-03 | Automation pauses at Duo MFA screen and waits for user to approve on phone, then detects successful login | `waitForSelector`/`waitForURL` polling with timeout -- see Architecture Patterns "MFA Wait Loop" |
| AUTH-04 | Automation authenticates to ACT CRM onboarding portal via same SSO session or separate auth flow | `storageState` carries cookies cross-domain within SSO; separate flow if needed -- see Architecture Patterns |
| AUTH-05 | Automation detects existing valid session and skips login when already authenticated | Load `storageState` from `.auth/`, navigate to target, check if redirected to login -- see Architecture Patterns "Session Detection" |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| playwright | ^1.58.0 | Browser automation engine | Industry standard for Node.js browser automation; built-in auto-wait, cross-browser, TypeScript-first |
| typescript | ^5.7.0 | Type safety | Required for project -- catches bugs at compile time, excellent Playwright type support |
| tsx | ^4.19.0 | TypeScript execution | Zero-config TS runner powered by esbuild; no build step needed for development |
| commander | ^13.0.0 | CLI argument parsing | 500M+ weekly downloads, lightweight (18ms startup), TypeScript definitions included |
| picocolors | ^1.1.0 | Terminal colors | Zero-dependency, fastest color lib (8.2M ops/sec), NO_COLOR friendly, tiny bundle |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/node | ^22.0.0 | Node.js type definitions | Always -- provides types for process.env, fs, path, etc. |

### Not Needed (Use Native Instead)
| Problem | Skip This | Use Instead | Why |
|---------|-----------|-------------|-----|
| .env loading | dotenv | Node.js `--env-file=.env` flag | Node v22 has native support; zero dependencies |
| Logging | pino / winston | Console + custom formatter | This is a CLI tool, not a server; console.log with picocolors is sufficient |
| Test runner | @playwright/test | playwright (library) | We are scripting automation, not writing tests; library API gives more control |

**Installation:**
```bash
npm init -y
npm install playwright commander picocolors
npm install -D typescript tsx @types/node
npx playwright install chromium
```

## Architecture Patterns

### Recommended Project Structure
```
hr-automation/
├── src/
│   ├── cli.ts              # CLI entry point (commander setup)
│   ├── auth/
│   │   ├── login.ts        # SSO login flow (UCPath + ACT CRM)
│   │   ├── session.ts      # Session save/load/detect logic
│   │   └── duo-wait.ts     # Duo MFA polling loop
│   ├── browser/
│   │   └── launch.ts       # Browser launch + context creation
│   └── utils/
│       ├── env.ts          # .env validation (fail-early check)
│       └── log.ts          # PII-safe console logger with colors
├── .auth/                  # Session state files (gitignored)
│   └── state.json          # Playwright storageState output
├── .env                    # Credentials (gitignored)
├── .gitignore
├── package.json
└── tsconfig.json
```

### Pattern 1: Playwright as Library (Not Test Runner)
**What:** Use `playwright` package directly, not `@playwright/test`. Launch browser, create context, script pages imperatively.
**When to use:** When building automation tools (not test suites). Gives full control over browser lifecycle.
**Example:**
```typescript
// Source: https://playwright.dev/docs/library
import { chromium, type BrowserContext, type Page } from "playwright";

async function createBrowser(statePath?: string) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    statePath ? { storageState: statePath } : undefined
  );
  const page = await context.newPage();
  return { browser, context, page };
}
```

### Pattern 2: Session Persistence with storageState
**What:** Save authenticated cookies/localStorage to a JSON file after login, load it on subsequent runs to skip login.
**When to use:** Every run after the first successful login.
**Example:**
```typescript
// Source: https://playwright.dev/docs/auth
import path from "node:path";

const AUTH_DIR = path.join(process.cwd(), ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");

// Save after successful login
await page.context().storageState({ path: STATE_FILE });

// Load on next run
const context = await browser.newContext({ storageState: STATE_FILE });
```

### Pattern 3: MFA Wait Loop (Duo Approval)
**What:** After entering credentials, poll for a post-login indicator (URL change or element) with a timeout. User approves Duo on their phone during this window.
**When to use:** AUTH-03 -- every SSO login that triggers Duo.
**Example:**
```typescript
// Duo MFA wait pattern -- poll for login completion
async function waitForDuoApproval(
  page: Page,
  successIndicator: string, // URL pattern or selector
  timeoutMs: number = 15_000
): Promise<boolean> {
  try {
    // waitForURL accepts string, glob, or regex
    await page.waitForURL(successIndicator, { timeout: timeoutMs });
    return true;
  } catch {
    return false; // Timed out -- caller decides retry or exit
  }
}

// Usage with retry (per user decision: retry once, then exit)
log.waiting("Waiting for Duo approval...");
let approved = await waitForDuoApproval(page, "**/ucpath.ucsd.edu/**");
if (!approved) {
  log.waiting("Retrying -- waiting for Duo approval...");
  approved = await waitForDuoApproval(page, "**/ucpath.ucsd.edu/**");
}
if (!approved) {
  log.error("Duo approval timed out after two attempts");
  process.exit(1);
}
log.success("Authenticated");
```

### Pattern 4: Session Detection (Already Logged In)
**What:** Load saved state, navigate to target page, check whether we land on the app or get redirected to login.
**When to use:** AUTH-05 -- on every run to skip login if session is valid.
**Example:**
```typescript
async function isSessionValid(page: Page, targetUrl: string): Promise<boolean> {
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    // If we're NOT on a login/SSO page, session is valid
    const currentUrl = page.url();
    const isOnLoginPage = currentUrl.includes("shibboleth")
      || currentUrl.includes("login")
      || currentUrl.includes("idp");
    return !isOnLoginPage;
  } catch {
    return false;
  }
}
```

### Pattern 5: PII-Safe Logging
**What:** Wrap console output with colored status symbols. Never interpolate credentials, emails, or PII into messages.
**When to use:** All CLI output throughout the tool.
**Example:**
```typescript
import pc from "picocolors";

const log = {
  step:    (msg: string) => console.log(pc.blue("->") + " " + msg),
  success: (msg: string) => console.log(pc.green("✓") + " " + msg),
  waiting: (msg: string) => console.log(pc.yellow("⏳") + " " + msg),
  error:   (msg: string) => console.error(pc.red("✗") + " " + msg),
};

// CORRECT: no PII
log.step("Entering credentials...");
// WRONG: leaks PII
// log.step(`Entering credentials for ${username}...`);
```

### Pattern 6: Env Validation (Fail Early)
**What:** Check that all required environment variables exist before launching any browser. Exit immediately with a clear message if anything is missing.
**When to use:** First thing in the CLI entry point, before any Playwright calls.
**Example:**
```typescript
function validateEnv(): { userId: string; password: string } {
  const required = ["UCPATH_USER_ID", "UCPATH_PASSWORD"] as const;
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    log.error(`Missing required .env variables: ${missing.join(", ")}`);
    log.error("Create a .env file with these variables. See .env.example");
    process.exit(1);
  }

  return {
    userId: process.env.UCPATH_USER_ID!,
    password: process.env.UCPATH_PASSWORD!,
  };
}
```

### Anti-Patterns to Avoid
- **Do NOT use `page.waitForTimeout()`:** This is a hard sleep. Use `waitForSelector` or `waitForURL` which resolve as soon as the condition is met.
- **Do NOT use `waitForNavigation()`:** Deprecated. Use `waitForURL()` which is race-condition free.
- **Do NOT use `page.pause()` for MFA:** This opens Inspector UI. Use `waitForURL`/`waitForSelector` with a timeout instead -- the user approves Duo on their phone, not in the browser.
- **Do NOT hardcode selectors before live discovery:** PeopleSoft generates dynamic IDs. Use text-based, role-based, or attribute selectors. Treat initial selectors as placeholders that WILL need adjustment.
- **Do NOT store credentials in code:** Always load from `process.env` via `--env-file`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session persistence | Custom cookie serialization | Playwright `storageState()` | Handles cookies + localStorage + IndexedDB atomically |
| Browser management | Custom Chromium download/launch | `npx playwright install chromium` | Handles OS-specific binaries, versioning, sandbox config |
| CLI argument parsing | Manual `process.argv` parsing | `commander` | Handles flags, help text, subcommands, validation |
| Terminal colors | ANSI escape codes | `picocolors` | Handles NO_COLOR, terminal detection, cross-platform |
| TypeScript execution | Custom build pipeline | `tsx` | Zero-config, esbuild-powered, handles ESM/CJS seamlessly |
| .env loading | Custom file parser | Node.js `--env-file` | Native, zero-dependency, handles edge cases in parsing |

**Key insight:** Every piece of infrastructure for this phase has a battle-tested solution. The only custom code should be the SSO login flow itself (navigating pages, entering credentials, waiting for MFA) and the CLI orchestration that ties it together.

## Common Pitfalls

### Pitfall 1: PeopleSoft Dynamic Element IDs
**What goes wrong:** Selectors like `#ICMyID_123` stop working on next page load because PeopleSoft regenerates numeric suffixes.
**Why it happens:** PeopleSoft's Classic UI uses server-generated IDs with session-specific suffixes.
**How to avoid:** Use text-based locators (`page.getByText()`), role-based locators (`page.getByRole()`), or partial attribute selectors (`[id*="KEYWORD"]`) instead of exact IDs. When you must use IDs, use partial matches.
**Warning signs:** Tests pass once, fail on next run with "element not found."

### Pitfall 2: Cross-Domain Cookie Scope with SSO
**What goes wrong:** Logging into UCPath (ucsd.edu domain) does not automatically carry auth to ACT CRM (my.site.com domain) because cookies are domain-scoped.
**Why it happens:** Shibboleth SSO sets cookies on the IdP domain, but the SP cookies are domain-specific. UCSD SSO may issue separate SP sessions for each service.
**How to avoid:** After UCPath login succeeds, navigate to ACT CRM and check if a second login is required. If yes, execute a second auth flow (the CONTEXT.md already anticipates this: "select Active Directory, enter same credentials, wait for Duo if required"). Save storageState AFTER both systems are authenticated.
**Warning signs:** UCPath works fine, ACT CRM redirects to login page.

### Pitfall 3: storageState Does Not Include Session Storage
**What goes wrong:** Session loads from file but app says "session expired" because critical tokens were in `sessionStorage`, not `localStorage` or cookies.
**Why it happens:** Playwright's `storageState()` captures cookies and localStorage but NOT sessionStorage (tab-scoped, non-persistent by design).
**How to avoid:** If session detection fails despite saved state, check browser DevTools for sessionStorage usage. If needed, supplement storageState with a manual sessionStorage save/restore snippet (Playwright docs provide one). Test empirically by saving state, closing, reopening, and navigating.
**Warning signs:** Saved sessions always appear "expired" even seconds after saving.

### Pitfall 4: Duo Iframe Detection
**What goes wrong:** Automation cannot find Duo elements because they live inside an iframe.
**Why it happens:** Duo Universal Prompt uses an iframe embedded in the Shibboleth IdP page.
**How to avoid:** Use `page.frameLocator()` to tunnel into the Duo iframe if needed. However, for our use case we do NOT need to interact with Duo -- we just wait for the user to approve on their phone. So we only need to detect when Duo is done (URL changes away from the IdP).
**Warning signs:** Trying to detect Duo status elements and getting "element not found."

### Pitfall 5: Browser State File Security
**What goes wrong:** Auth state file (`.auth/state.json`) gets committed to git, exposing session cookies.
**Why it happens:** Developer forgets to add `.auth/` to `.gitignore` or force-adds the file.
**How to avoid:** Add `.auth/` to `.gitignore` as part of project setup (task 1). Verify with `git status` that `.auth/` never appears in tracked files.
**Warning signs:** `git diff` shows JSON with cookie values.

### Pitfall 6: Headless Mode Breaks Duo
**What goes wrong:** Browser launches in headless mode; user cannot see or interact with Duo prompt.
**Why it happens:** Playwright defaults to `headless: true`.
**How to avoid:** Always launch with `chromium.launch({ headless: false })`. This is a hard requirement -- Duo MFA requires the user to see the browser. (Also noted in project Out of Scope: "Headless browser mode -- Duo MFA requires visible browser for user to approve")
**Warning signs:** Script hangs forever waiting for MFA with no visible browser.

## Code Examples

### Complete test-login CLI Command Structure
```typescript
// src/cli.ts
// Source: commander docs + Playwright library pattern
import { Command } from "commander";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .option("--fresh", "Force fresh login (ignore saved session)")
  .action(async (options: { fresh?: boolean }) => {
    // 1. Validate .env
    // 2. Launch browser (with or without saved state)
    // 3. Navigate to UCPath, detect if login needed
    // 4. If login needed: SSO flow + Duo wait
    // 5. Navigate to ACT CRM, detect if login needed
    // 6. If login needed: second auth flow
    // 7. Save state to .auth/
    // 8. Print summary, close browser
  });

program.parse();
```

### package.json Scripts
```json
{
  "name": "hr-automation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test-login": "tsx --env-file=.env src/cli.ts test-login",
    "test-login:fresh": "tsx --env-file=.env src/cli.ts test-login --fresh",
    "typecheck": "tsc --noEmit"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"]
}
```

### Browser Launch with Session State
```typescript
// src/browser/launch.ts
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

const AUTH_DIR = path.join(process.cwd(), ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");

export async function launchBrowser(fresh: boolean = false): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.launch({ headless: false });

  const hasState = !fresh && fs.existsSync(STATE_FILE);
  const context = await browser.newContext(
    hasState ? { storageState: STATE_FILE } : undefined
  );
  const page = await context.newPage();

  return { browser, context, page };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: STATE_FILE });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| dotenv package for .env | Node.js `--env-file` flag | Node v20.6.0 (2023) | Zero dependency for env loading |
| ts-node for TypeScript | tsx (esbuild-powered) | 2023-2024 | 10-50x faster startup, zero config |
| `waitForNavigation()` | `waitForURL()` | Playwright v1.20+ | No race conditions |
| Chalk 5 (ESM-only) | picocolors | 2023+ | 2x faster, zero deps, CJS+ESM |
| Custom cookie management | Playwright `storageState()` | Playwright v1.14+ | Atomic save/load of all browser state |
| commander v11 (CJS) | commander v13 (ESM+CJS) | 2024 | Full ESM support, faster |

**Deprecated/outdated:**
- `page.waitForNavigation()`: Deprecated in favor of `page.waitForURL()` -- do not use
- dotenv: Unnecessary on Node v20.6.0+; use `--env-file` flag
- ts-node: Slower and more complex than tsx; use tsx for development
- Chalk 5: ESM-only, requires workarounds for CJS; use picocolors instead

## Open Questions

1. **UCSD SSO Login Page Selectors**
   - What we know: UCPath uses Shibboleth SSO at ucsd.edu. There is a "Log in to UCPath" button and a campus selector (UC San Diego).
   - What's unclear: Exact HTML structure, element IDs/classes, whether there are iframes. PeopleSoft may wrap SSO in an iframe.
   - Recommendation: Implement login with best-guess selectors from UCSD SSO patterns (text-based: "Log in to UCPath", "UC San Diego"), then validate and adjust against the live site during first manual test run. Use `page.getByText()` and `page.getByRole()` for resilience.

2. **ACT CRM Login Page Structure**
   - What we know: It's at act-crm.my.site.com (Salesforce Experience Cloud). If separate login needed, must select "Active Directory" from a dropdown before entering credentials.
   - What's unclear: Whether SSO session from UCPath carries over. Whether the "Active Directory" dropdown is a native select, a Salesforce Lightning component, or custom HTML.
   - Recommendation: Build the ACT CRM auth as a separate flow module. After UCPath login, navigate to ACT CRM and detect if login page appears. If yes, handle the dropdown + credential entry. Salesforce often uses custom components -- plan for `frameLocator()` or `page.locator()` with flexible selectors.

3. **Cross-Domain SSO Behavior (One Duo or Two?)**
   - What we know: Both systems use UCSD SSO. STATE.md flags this as a known unknown.
   - What's unclear: Whether authenticating to UCPath satisfies ACT CRM's SSO, or if a second Duo prompt fires.
   - Recommendation: Code for the worst case (two separate auth flows, two Duo prompts). If empirical testing shows one is enough, the second flow gracefully no-ops via session detection.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| Config file | None needed -- built-in runner requires no config |
| Quick run command | `npx tsx --env-file=.env --test src/**/*.test.ts` |
| Full suite command | `npx tsx --env-file=.env --test src/**/*.test.ts && npx tsc --noEmit` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Browser launches and navigates to UCPath | smoke (manual) | Manual: `npm run test-login` -- verify browser opens and UCPath loads | N/A -- manual only |
| AUTH-02 | SSO login with stored credentials | smoke (manual) | Manual: `npm run test-login` -- verify credentials entered, SSO proceeds | N/A -- manual only |
| AUTH-03 | Duo MFA wait + success detection | smoke (manual) | Manual: `npm run test-login` -- approve Duo, verify "Authenticated" message | N/A -- manual only |
| AUTH-04 | ACT CRM authentication | smoke (manual) | Manual: `npm run test-login` -- verify ACT CRM shows authenticated state | N/A -- manual only |
| AUTH-05 | Session reuse (skip login) | smoke (manual) | Manual: run `npm run test-login` twice -- second should skip login | N/A -- manual only |
| -- | Env validation (missing vars) | unit | `npx tsx --test src/utils/env.test.ts` | No -- Wave 0 |
| -- | Log utility (no PII leak) | unit | `npx tsx --test src/utils/log.test.ts` | No -- Wave 0 |
| -- | TypeScript compiles | unit | `npx tsc --noEmit` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit` (type checking)
- **Per wave merge:** `npx tsc --noEmit` + manual `npm run test-login`
- **Phase gate:** Full manual test-login flow succeeds (both systems authenticated, session saved, second run skips login)

### Wave 0 Gaps
- [ ] `src/utils/env.test.ts` -- unit test for env validation (missing vars, present vars)
- [ ] `src/utils/log.test.ts` -- unit test that log output contains no PII patterns
- [ ] `tsconfig.json` -- TypeScript config (created during scaffolding)
- [ ] `package.json` test script -- `"test": "tsx --test src/**/*.test.ts"`

**Note:** AUTH-01 through AUTH-05 are inherently manual-only tests because they require a live browser, real UCSD SSO, and human Duo MFA approval. They cannot be meaningfully automated without mocking the entire authentication stack, which would not validate real behavior. The phase gate is a successful end-to-end manual run of `test-login`.

## Sources

### Primary (HIGH confidence)
- [Playwright Auth Docs](https://playwright.dev/docs/auth) - storageState API, session persistence patterns
- [Playwright Library Docs](https://playwright.dev/docs/library) - Using Playwright as a library (not test runner)
- [Playwright BrowserContext API](https://playwright.dev/docs/api/class-browsercontext) - storageState() method signature
- [Playwright Browsers Docs](https://playwright.dev/docs/browsers) - Chromium installation, channel options
- [Playwright Navigations Docs](https://playwright.dev/docs/navigations) - waitForURL() best practice over deprecated waitForNavigation()
- [tsx official docs](https://tsx.is/) - TypeScript Execute runner

### Secondary (MEDIUM confidence)
- [Playwright npm page](https://www.npmjs.com/package/playwright) - Current version 1.58.2 confirmed
- [Node.js native --env-file](https://infisical.com/blog/stop-using-dotenv-in-nodejs-v20.6.0+) - Native .env support since v20.6.0, verified on local Node v22.17.0
- [picocolors GitHub](https://github.com/alexeyraspopov/picocolors) - Performance benchmarks, API surface
- [commander npm](https://www.npmjs.com/package/commander) - Weekly downloads, TypeScript support
- [Playwright SSO automation (Medium, Jan 2026)](https://medium.com/@biresh.patel/playwright-sso-automation-from-local-poc-to-github-actions-a1913d860ff0) - SSO automation patterns
- [Playwright persistent context (BrowserStack)](https://www.browserstack.com/guide/playwright-persistent-context) - launchPersistentContext vs newContext comparison
- [UCSD Two-Step Login](https://blink.ucsd.edu/technology/security/services/two-step-login/index.html) - Duo MFA is UCSD's standard

### Tertiary (LOW confidence)
- UCSD SSO login page HTML structure -- not publicly documented, requires live inspection
- ACT CRM (Salesforce Experience Cloud) login page structure -- requires authenticated access to inspect
- Cross-domain SSO behavior between UCPath and ACT CRM -- requires empirical testing

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Playwright, TypeScript, tsx, commander, picocolors are all well-documented, widely used, and verified against official sources
- Architecture: HIGH - Patterns (storageState, waitForURL, library mode) come directly from Playwright official docs
- Pitfalls: MEDIUM - PeopleSoft quirks and cross-domain SSO behavior are based on general patterns, not verified against these specific UCSD pages
- SSO selectors: LOW - Cannot be determined without live browser access to ucpath.ucsd.edu and act-crm.my.site.com

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (30 days -- stable domain, Playwright releases are backward-compatible)
