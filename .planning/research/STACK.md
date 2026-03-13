# Stack Research

**Domain:** Browser automation / HR data transfer (PeopleSoft + Salesforce scraping with SSO + Duo MFA)
**Researched:** 2026-03-13
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Playwright** | 1.58.x | Browser automation engine | Industry standard for modern browser automation. Direct browser protocol communication (no WebDriver middle layer like Selenium). Native iframe/FrameLocator support critical for PeopleSoft. Native Shadow DOM piercing critical for Salesforce Lightning. Built-in auto-waiting eliminates flaky timing issues with dynamic PeopleSoft elements. Persistent context (`launchPersistentContext`) enables session reuse across SSO auth. `page.pause()` provides clean Duo MFA pause point. Confidence: HIGH -- verified via official docs at playwright.dev. |
| **Node.js** | 22.x LTS | Runtime | Current LTS (supported through April 2027). Native `--env-file` flag eliminates dotenv dependency for simple cases. Required by Playwright. TypeScript ecosystem is strongest here. Confidence: HIGH. |
| **TypeScript** | 5.7.x | Language | Type safety prevents runtime errors when mapping scraped data fields between systems. Zod schema integration gives runtime validation. Catches field mapping mismatches at compile time. Confidence: HIGH. |
| **tsx** | 4.x | TypeScript execution | Runs TypeScript directly without compilation step via esbuild transpilation. Faster startup than ts-node, better ESM support. `tsx --watch` replaces both ts-node and nodemon. Confidence: HIGH -- verified via tsx.is docs. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **zod** | 3.x | Data validation and schema definition | Define schemas for scraped employee data (names, SSN, addresses, dates). Validates extracted data before entering it into UCPath. Catches malformed scrapes early with clear error messages. Zero dependencies. Confidence: HIGH. |
| **commander** | 14.x | CLI framework | Parse command-line arguments for batch employee email input. Provides `--help`, subcommands, option parsing out of the box. 118K+ dependents, proven stable. Requires Node.js v20+. Confidence: HIGH. |
| **dotenv** | 16.x | Environment variable loading | Load UCSD SSO credentials from `.env` file. While Node.js 22 has native `--env-file`, dotenv's `.env.example` pattern and broader tooling support makes it more practical for a project handling sensitive credentials (SSN, passwords). Confidence: HIGH. |
| **winston** | 3.x | Structured logging | Log automation steps, errors, and data extraction results. Winston over Pino because: human-readable output matters for HR staff debugging failed runs; multiple transports (console + file) for audit trails of which employees were processed; Pino's performance advantage is irrelevant at this scale. Confidence: MEDIUM. |
| **csv-parse** | 5.x | CSV parsing (from `csv` package) | Parse batch employee email lists from CSV files. Stream-based, part of the larger `csv` suite. 1.4M weekly downloads, most robust for Node.js. Confidence: HIGH. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **Playwright Inspector** | Visual element selector discovery | Launch with `PWDEBUG=1` or `page.pause()`. Essential for finding stable selectors in PeopleSoft's dynamic DOM. Use `npx playwright codegen` to record initial navigation flows. |
| **Playwright Trace Viewer** | Post-mortem debugging | Records DOM snapshots, network requests, and console logs. Critical for debugging why a PeopleSoft form fill failed without re-running the entire flow. |
| **ESLint + Prettier** | Code quality | Standard TypeScript linting. Flat config format (eslint.config.js). |
| **vitest** | Unit testing | Test data transformation logic (scrape-to-form mapping) without browser. Fast, TypeScript-native, ESM-first. |

## Installation

```bash
# Core automation
npm install playwright

# Install browser binaries (Chromium only -- no need for Firefox/WebKit)
npx playwright install chromium

# CLI and data handling
npm install commander zod dotenv winston csv-parse

# Dev dependencies
npm install -D typescript tsx @types/node vitest eslint prettier
```

### Project Initialization

```bash
# Initialize TypeScript
npx tsc --init

# Key tsconfig.json settings
# target: "ES2022"
# module: "NodeNext"
# moduleResolution: "NodeNext"
# strict: true
# outDir: "./dist"
# rootDir: "./src"
```

### npm Scripts (package.json)

```json
{
  "scripts": {
    "dev": "tsx --watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "codegen": "npx playwright codegen ucpath.ucsd.edu"
  }
}
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Playwright** | Selenium WebDriver | Only if you need IE11 support or are extending an existing Selenium infrastructure. Selenium's WebDriver layer adds latency and its iframe handling is more manual. For a greenfield project in 2026 targeting PeopleSoft + Salesforce, there is no reason to choose Selenium. |
| **Playwright** | Puppeteer | Only if you exclusively target Chromium and want a smaller dependency. Puppeteer lacks Playwright's FrameLocator API and cross-browser support. Playwright was built by the same team (ex-Puppeteer devs at Microsoft) and supersedes it. |
| **TypeScript** | Plain JavaScript | Only if the team has zero TypeScript experience and timeline is extremely tight. The type safety for employee data schemas (SSN, addresses, dates) is worth the small learning curve. |
| **tsx** | ts-node | Only if you hit an edge case tsx can't handle. ts-node has poorer ESM support and slower startup. tsx is the modern standard. |
| **commander** | yargs | Only if you need complex nested subcommands with middleware. Commander is simpler and sufficient for this project's CLI needs (accept email list, run automation). |
| **winston** | pino | Only if logging volume is high (thousands of logs/sec). Pino is 5-10x faster but outputs JSON that requires `pino-pretty` for human reading. Winston's human-readable defaults are better for an HR tool run by staff. |
| **csv-parse** | papaparse | Only if you also need browser-side CSV parsing. Papaparse is browser-first; csv-parse is Node.js-first with better streaming support. |
| **zod** | joi / yup | Only if you need older Node.js compatibility. Zod's TypeScript-first design with `z.infer<>` type extraction is significantly better for this use case where scraped data schemas map directly to form entry types. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Selenium WebDriver** | Extra WebDriver layer adds latency and complexity. Playwright's direct CDP protocol is faster and more reliable. Selenium's iframe handling requires manual frame switching (driver.switchTo().frame()) while Playwright's FrameLocator chains naturally. Community has shifted to Playwright for new projects. | Playwright |
| **Puppeteer** | Chromium-only, no FrameLocator API, smaller feature set. Built by same team that then built Playwright as its successor. | Playwright |
| **Cheerio / jsdom** | Static HTML parsers that cannot execute JavaScript. PeopleSoft and Salesforce Lightning are heavily JS-driven SPAs. Pages render dynamically -- static parsing will get empty/incomplete DOM. | Playwright (full browser rendering) |
| **Axios / node-fetch for scraping** | HTTP-level scraping cannot handle SSO redirects, Duo MFA, JavaScript rendering, or session cookies across PeopleSoft and Salesforce. These systems require a real browser. | Playwright (real browser instance) |
| **dotenv-vault / Infisical** | Overkill for a single-user CLI tool. The credentials are the user's own UCSD SSO login, not shared API keys. A local `.env` file with `.gitignore` is appropriate. | dotenv with .env + .gitignore |
| **Playwright Test runner (@playwright/test)** | Designed for test suites, not automation scripts. Adds test framework overhead (fixtures, assertions, reporters) that is unnecessary for a CLI tool that drives a browser. Use the `playwright` library package directly. | `playwright` (library mode) |
| **Headless browser services (Browserless, BrowserStack)** | Authentication requires a local browser for Duo MFA phone approval. Cloud browsers cannot display the approval prompt to the user sitting at their desk. | Local Playwright with `headless: false` |

## Stack Patterns by Variant

**For development and debugging:**
- Launch with `headless: false` and `slowMo: 100` to visually observe automation
- Use `page.pause()` at Duo MFA prompt to open Playwright Inspector
- Use `PWDEBUG=1` environment variable for full debug mode
- Use `npx playwright codegen [url]` to record selector discovery sessions

**For daily use by HR staff:**
- Launch with `headless: false` (must see Duo prompt) but no slowMo
- Minimize `slowMo` -- only add if UCPath pages need extra settling time
- Use `launchPersistentContext` with a dedicated `userDataDir` to preserve SSO session cookies between runs, reducing re-authentication frequency
- Log each employee processed to a file for audit trail

**For PeopleSoft (UCPath) navigation:**
- Use `page.frameLocator()` for PeopleSoft's nested iframe structure
- Chain frame locators: `page.frameLocator('#ptifrmtgtframe').frameLocator('#ptifrmtgtframe')`
- Avoid CSS ID selectors for dynamic PeopleSoft IDs (they contain `$0`, `$1` suffixes that change)
- Prefer `getByRole()`, `getByLabel()`, or `getByText()` over CSS selectors where possible
- Fall back to `locator('[id*="PARTIAL_STABLE_ID"]')` with partial attribute matching for PeopleSoft elements

**For Salesforce (ACT CRM) navigation:**
- Playwright natively pierces Shadow DOM boundaries (Salesforce Lightning uses custom Shadow DOM)
- Use `getByRole()` and `getByLabel()` locators that work through shadow roots
- Salesforce community portals (`.my.site.com`) may have simpler DOM than full Lightning -- test actual selectors with `codegen`
- Expect Salesforce to use dynamic class names; never select by generated CSS classes

**For Duo MFA handling:**
- Run in headed mode (`headless: false`) -- non-negotiable for MFA
- After entering SSO credentials, use `page.waitForURL()` with a pattern matching the post-auth landing page
- Set a generous timeout (e.g., 120 seconds) to give user time to approve Duo push
- Example pattern: `await page.waitForURL('**/ucpath.ucsd.edu/**', { timeout: 120000 })`
- Do NOT attempt to automate Duo approval -- it violates UC policy and is technically fragile

**For session persistence across systems:**
- Use `launchPersistentContext` with a dedicated directory (NOT the default Chrome profile)
- UCSD SSO sets cookies that should carry across both UCPath and ACT CRM domains
- Save `storageState` after successful auth for faster subsequent runs
- Be aware: session cookies may expire; build retry logic for re-authentication

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| playwright@1.58.x | Node.js 20.x, 22.x | Requires Node.js 18+ (use 22 LTS for best support). Ships Chromium 145, Firefox 146, WebKit 26. |
| typescript@5.7.x | tsx@4.x, Node.js 22.x | Use `"module": "NodeNext"` in tsconfig for ESM compatibility with tsx. |
| tsx@4.x | Node.js 20.x, 22.x | Based on esbuild. Does NOT type-check; pair with `tsc --noEmit` for type safety. |
| commander@14.x | Node.js 20.x, 22.x | Requires Node.js v20+. Commander 15 requires Node.js v22.12+; stick with 14.x for broader compatibility. |
| zod@3.x | TypeScript 5.x | Use `z.infer<typeof schema>` for automatic type extraction from schemas. |
| winston@3.x | Node.js 20.x, 22.x | Stable major version. Transports: Console + File for this project. |
| csv-parse@5.x | Node.js 20.x, 22.x | Part of the `csv` family. Import as `import { parse } from 'csv-parse'` or `'csv-parse/sync'` for small files. |
| vitest@3.x | TypeScript 5.x, Node.js 22.x | ESM-native test runner. Compatible with tsx's transpilation approach. |

## Key Architectural Notes for Stack Usage

### Playwright Library Mode (not Test Mode)

This project uses `playwright` (the library), NOT `@playwright/test` (the test framework). The difference matters:

```typescript
// CORRECT: Library mode for automation scripts
import { chromium } from 'playwright';

const browser = await chromium.launchPersistentContext('./user-data', {
  headless: false,
  slowMo: 50,
});
const page = browser.pages()[0] || await browser.newPage();
```

```typescript
// WRONG: Test mode -- do not use for this project
import { test, expect } from '@playwright/test';
test('login', async ({ page }) => { ... });
```

### Persistent Context for SSO Session Reuse

```typescript
// Launch with persistent context to preserve cookies between runs
const context = await chromium.launchPersistentContext('./auth-data', {
  headless: false,  // Must see Duo MFA prompt
  viewport: { width: 1280, height: 800 },
  // userDataDir is the first argument -- stores cookies, localStorage
});
```

### Duo MFA Pause Pattern

```typescript
// Navigate to SSO login
await page.goto('https://ucpath.ucsd.edu');
// ... enter credentials ...

// Wait for user to approve Duo push (up to 2 minutes)
console.log('Approve the Duo push notification on your phone...');
await page.waitForURL('**/ucpath.ucsd.edu/**', {
  timeout: 120_000,  // 2 minutes for Duo approval
});
console.log('Login successful.');
```

### PeopleSoft iframe Navigation

```typescript
// PeopleSoft wraps content in nested iframes
const mainFrame = page.frameLocator('#ptifrmtgtframe');

// Use text/role locators instead of dynamic IDs
await mainFrame.getByRole('link', { name: 'Smart HR Templates' }).click();
await mainFrame.getByText('Smart HR Transactions').click();

// For elements with semi-stable IDs containing dynamic suffixes
await mainFrame.locator('[id*="UC_FULL_HIRE"]').click();
```

## Sources

- [Playwright Official Docs - Authentication](https://playwright.dev/docs/auth) -- storageState, persistent context, SSO handling (HIGH confidence)
- [Playwright Official Docs - FrameLocator](https://playwright.dev/docs/api/class-framelocator) -- iframe API for PeopleSoft (HIGH confidence)
- [Playwright Official Docs - Release Notes](https://playwright.dev/docs/release-notes) -- v1.58 current stable, Chromium 145 (HIGH confidence)
- [Playwright Official Docs - BrowserType](https://playwright.dev/docs/api/class-browsertype) -- launchPersistentContext API (HIGH confidence)
- [Playwright vs Selenium 2025 - Browserless](https://www.browserless.io/blog/playwright-vs-selenium-2025-browser-automation-comparison) -- market comparison (MEDIUM confidence)
- [Playwright vs Selenium 2026 - BrowserStack](https://www.browserstack.com/guide/playwright-vs-selenium) -- Playwright now #1 automation tool (MEDIUM confidence)
- [Salesforce Test Automation with Playwright - TestRig](https://www.testrigtechnologies.com/salesforce-test-automation-with-playwright-challenges-setup-and-proven-strategies/) -- Shadow DOM, Lightning handling (MEDIUM confidence)
- [Salesforce UI Testing Challenges - Gearset](https://gearset.com/blog/salesforce-ui-testing-challenges/) -- Shadow DOM piercing, data-test attributes (MEDIUM confidence)
- [PeopleTools Portal Technologies - Oracle](https://docs.oracle.com/cd/E24150_01/pt851h2/eng/psbooks/tprt/htm/tprt12.htm) -- PeopleSoft iframe structure (MEDIUM confidence)
- [Elire Consulting - Building PeopleSoft Test Framework](https://elire.com/building-ptf-test-framework/) -- PeopleSoft automation patterns (MEDIUM confidence)
- [tsx.is](https://tsx.is/) -- tsx TypeScript runner docs (HIGH confidence)
- [Commander.js GitHub](https://github.com/tj/commander.js) -- CLI framework v14 (HIGH confidence)
- [Zod Official Docs](https://zod.dev/) -- schema validation (HIGH confidence)
- [npm: playwright](https://www.npmjs.com/package/playwright) -- v1.58.x current (HIGH confidence)
- [npm: commander](https://www.npmjs.com/package/commander) -- v14.0.3 current (HIGH confidence)
- [Pino vs Winston - Better Stack](https://betterstack.com/community/guides/scaling-nodejs/pino-vs-winston/) -- logging comparison (MEDIUM confidence)
- [Node.js dotenv in 2025 - Infisical](https://infisical.com/blog/stop-using-dotenv-in-nodejs-v20.6.0+) -- env management practices (MEDIUM confidence)
- [CSV Parsers Comparison - LeanLabs](https://leanylabs.com/blog/js-csv-parsers-benchmarks/) -- csv-parse vs papaparse benchmarks (MEDIUM confidence)

---
*Stack research for: UCPath HR Browser Automation (PeopleSoft + Salesforce + SSO/Duo MFA)*
*Researched: 2026-03-13*
