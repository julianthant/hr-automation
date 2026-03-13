# Pitfalls Research

**Domain:** Browser automation for PeopleSoft (UCPath) and Salesforce (ACT CRM) HR data entry
**Researched:** 2026-03-13
**Confidence:** HIGH (PeopleSoft/iframe pitfalls), MEDIUM (Salesforce portal specifics), HIGH (SSO/MFA, data security)

## Critical Pitfalls

### Pitfall 1: PeopleSoft Full-Page Postbacks Destroying Element References

**What goes wrong:**
PeopleSoft performs a full server round-trip (postback) after many field interactions -- dropdown selections, tab clicks, checkbox changes. Every postback replaces the entire DOM inside the iframe. Any element references stored before the postback become stale and throw errors. Automation scripts that locate elements once and reuse references will fail intermittently and unpredictably.

**Why it happens:**
Developers build automation the natural way: find element, store reference, interact later. PeopleSoft's architecture is fundamentally different from modern SPAs -- it rebuilds the page on the server and sends back a complete HTML replacement. This is invisible in manual use but breaks every stored locator.

**How to avoid:**
- Never cache element references across interactions. Re-locate elements immediately before every interaction.
- After any click, dropdown selection, or field entry that triggers a postback, wait for the page to stabilize before proceeding. Detect stability by waiting for the PeopleSoft processing indicator (spinner) to disappear and/or waiting for the iframe to finish loading.
- Build a wrapper function like `findAndAct(selector, action)` that always re-queries the DOM.

**Warning signs:**
- Intermittent `StaleElementReferenceException` or element-not-found errors that pass sometimes and fail other times.
- Scripts that work on the first field but fail on the second or third.
- Errors that appear only after dropdown selections or tab switches.

**Phase to address:**
Phase 1 (Core automation framework). This must be baked into the lowest-level interaction helpers from day one. Retrofitting is painful.

---

### Pitfall 2: PeopleSoft Iframe Nesting -- Operating on the Wrong Frame

**What goes wrong:**
PeopleSoft wraps its application content inside an iframe named `TargetContent` (element ID `ptifrmtgtframe`). All form fields, buttons, and navigation elements live inside this iframe, not in the top-level page. Automation scripts that query the top-level `page` object directly will find zero elements and produce baffling "element not found" errors on elements that are clearly visible in the browser.

**Why it happens:**
PeopleSoft's portal architecture uses a frameset: the outer page is the portal chrome (header, navigation sidebar), and the actual application content loads inside `ptifrmtgtframe`. This is an architectural decision from the early 2000s that persists in all modern PeopleSoft deployments including UCPath. Developers who inspect elements in DevTools see them fine, but don't notice the iframe boundary.

**How to avoid:**
- Use Playwright's `page.frameLocator('#ptifrmtgtframe')` as the root for ALL element queries inside UCPath. Never query `page` directly for application content.
- Create a helper that returns the content frame and use it everywhere:
  ```typescript
  const contentFrame = () => page.frameLocator('#ptifrmtgtframe');
  contentFrame().locator('#FIELD_ID').click();
  ```
- If nested iframes appear (PeopleSoft occasionally nests secondary iframes for modal dialogs), chain frame locators.

**Warning signs:**
- Every single locator returns "not found" even though the element is visible on screen.
- Scripts work in non-portal PeopleSoft access but fail through the portal URL.
- DevTools shows elements fine, but `page.locator()` returns nothing.

**Phase to address:**
Phase 1 (UCPath login and navigation). The very first interaction with UCPath post-login will hit this. Must be solved before any other UCPath work proceeds.

---

### Pitfall 3: PeopleSoft Dynamic Element IDs That Are Actually Stable (and Vice Versa)

**What goes wrong:**
Developers assume all PeopleSoft element IDs are dynamic and unreliable, so they build complex XPath strategies or text-based selectors. In reality, PeopleSoft element IDs follow a predictable convention: `RECORDNAME_FIELDNAME` for most fields, or a custom page field name set in App Designer. These are stable across sessions. However, some IDs include a window prefix (`win0divXXX`, `win1divXXX`) that changes between windows/tabs. Misunderstanding which parts are stable and which are not leads to either over-engineered brittle XPath selectors or under-engineered ID selectors that break on window changes.

**Why it happens:**
PeopleSoft's ID convention is officially undocumented by Oracle. Blog posts and community wisdom are the only references. The `win0` prefix looks dynamic but is actually tied to the window number (usually `win0` for the main window). The real trap is fields with custom page field names (like `SA_MASK_NID2` instead of `PERS_NID_PRM_VW_NATIONAL_ID`) that don't follow the record/field pattern.

**How to avoid:**
- Prefer `id`-based selectors for PeopleSoft fields. They are more stable than XPath in this context.
- Use partial ID matching (`[id$="_FIELDNAME"]`) to avoid the `win0` prefix dependency.
- For the UC_FULL_HIRE template specifically, manually catalog the actual element IDs by inspecting the live page. Build a selector map once and store it as configuration.
- Never rely on element position or index -- PeopleSoft grids and repeating sections change order.

**Warning signs:**
- Over-reliance on XPath with positional selectors (`//div[3]/table[2]/tr[1]`).
- Selectors that break when a different number of rows exist in a grid.
- Different behavior when opening the same page in a new PeopleSoft window.

**Phase to address:**
Phase 2 (Data extraction and form entry). Build the selector map as a discoverable, maintainable configuration file during the first real form interaction work.

---

### Pitfall 4: SSN and PII Leaking into Logs, Screenshots, and Error Reports

**What goes wrong:**
Browser automation frameworks log extensively by default -- page content, element text, screenshot captures on failure, network request/response bodies. When automating HR workflows involving SSNs, addresses, and salary data, this sensitive information ends up in log files, error screenshots, CI artifacts, and crash reports. A single unredacted log file committed to git or visible in a shared terminal exposes employee PII.

**Why it happens:**
Playwright's default behavior captures screenshots on test failure, traces include full page content, and console logs capture DOM state. Developers focus on getting automation working and don't think about what gets captured in failure modes until after PII is already in logs.

**How to avoid:**
- Disable automatic screenshot capture on failure, or implement a screenshot function that redacts known PII regions.
- Never log raw extracted data. Log only field names and success/failure status, never values: `"Extracted SSN: SUCCESS"` not `"Extracted SSN: 123-45-6789"`.
- Add `.env`, `auth/`, `*.json` state files, and log directories to `.gitignore` from the start.
- Store extracted employee data only in memory during processing. If writing to disk is necessary, encrypt at rest and delete after the batch completes.
- Never include PII in error messages thrown by the application.

**Warning signs:**
- Log files that grow large (they may contain page HTML with PII).
- Screenshots in any output directory showing employee data.
- Error messages that include "could not find value '123-45-6789'" type strings.
- Any `console.log(data)` or `print(data)` calls on extracted employee objects.

**Phase to address:**
Phase 1 (Project setup). The `.gitignore`, logging conventions, and data handling patterns must be established before any PII-touching code is written. Retrofitting PII protections is both tedious and risky (you might miss one).

---

### Pitfall 5: Duo MFA Pause Logic That Breaks Session Flow

**What goes wrong:**
The automation pauses for manual Duo MFA approval, but the pause mechanism is poorly implemented -- either it times out too quickly (failing before the user can approve), blocks indefinitely (hanging if approval is denied or phone is unavailable), or resumes too early (before the SSO redirect completes post-approval). The result is either the automation crashes, hangs forever, or proceeds into an unauthenticated state and fails downstream.

**Why it happens:**
Duo MFA involves multiple redirects: UCSD SSO page -> Duo prompt page -> Duo push sent -> user approves on phone -> Duo page auto-submits -> redirect back to original application. Each step has variable timing. A naive `page.waitForTimeout(30000)` either isn't enough or wastes time. A naive "wait for URL to change" may trigger on intermediate redirects before the final destination is reached.

**How to avoid:**
- Wait for a definitive post-authentication indicator, not a URL pattern or timeout. For UCPath, wait for a PeopleSoft-specific element (like the homepage menu or the `ptifrmtgtframe` iframe) to appear. For ACT CRM, wait for the Salesforce page layout to load.
- Implement a polling loop with a generous timeout (90-120 seconds) that checks for the authenticated landing page every 2-3 seconds.
- Provide clear CLI output telling the user what to do: `"Waiting for Duo MFA approval... Approve the push notification on your phone."` and `"Timed out after 120 seconds. Please re-run."`.
- Handle the denial/timeout case gracefully -- detect the Duo error page and exit with a clear message rather than cascading failures.

**Warning signs:**
- Automation works sometimes but fails at login "randomly" (it's timing).
- The script hangs with no output after the login step.
- Users report it "worked once but never again" (session state confusion).

**Phase to address:**
Phase 1 (Authentication). This is the gate to everything else. Robust MFA handling must be proven solid before any downstream work is built on top of it.

---

### Pitfall 6: Cross-Domain Session Assumption Between UCPath and ACT CRM

**What goes wrong:**
The project assumes a single SSO session will authenticate both UCPath (ucpath.ucsd.edu) and ACT CRM (act-crm.my.site.com). In practice, these are different identity providers or relying parties -- UCPath uses UCSD SSO (Shibboleth/SAML) to authenticate into PeopleSoft, while ACT CRM uses UCSD SSO to authenticate into Salesforce. Even though both use UCSD SSO as the identity provider, the session cookies are domain-scoped (`ucsd.edu` vs `my.site.com`). The browser may require a fresh authentication flow for the second system, including a second Duo MFA prompt.

**Why it happens:**
SSO gives the illusion of "one login, access everything." In reality, SSO means the identity provider remembers you're authenticated, so subsequent logins are faster (pre-filled credentials, possibly no password re-entry), but each service provider still needs its own session established. Whether a second Duo prompt is required depends on Duo's "remembered device" policy and session timeout configuration, which the automation developer doesn't control.

**How to avoid:**
- Design the authentication flow to handle each system independently. Log into UCPath first, save session state, then navigate to ACT CRM and handle its login flow (which may or may not require Duo again).
- Use Playwright's `storageState` to save and restore browser session state, but understand that cookies are domain-scoped -- saving state captures all domains.
- Test the two-system login flow manually in an automated browser instance (not your regular browser with existing sessions) to observe the actual redirect behavior.
- Build the authentication as two separate, testable modules that can each handle a full SSO+MFA cycle.

**Warning signs:**
- Authentication works for UCPath but ACT CRM shows a login page unexpectedly.
- Second Duo prompt appears when the code doesn't expect one.
- Session works in developer's regular browser (which has cached SSO tokens) but fails in Playwright's clean browser context.

**Phase to address:**
Phase 1 (Authentication for both systems). Test both systems in a clean browser context early. Do not assume shared authentication until proven in the actual automation browser.

---

### Pitfall 7: Creating Duplicate or Incorrect HR Transactions with No Undo

**What goes wrong:**
UCPath Smart HR Transactions create real payroll-affecting records. If the automation submits a UC_FULL_HIRE template with wrong data, submits it twice for the same employee, or submits for the wrong employee, the consequences are serious: incorrect hire records, duplicate employees in the payroll system, wrong salary data, or SSN mismatches. PeopleSoft does not have an "undo" button for submitted transactions -- corrections require manual intervention by UCPC WFA Production staff.

**Why it happens:**
Batch processing loops can re-process an already-completed employee if the script crashes mid-batch and restarts. A selector that targets the wrong row in a search results grid silently processes the wrong person's data. A race condition where the "Create Transaction" button is clicked twice during a slow postback creates a duplicate. Automation gives a false sense of confidence -- it moves fast and doesn't ask "are you sure?"

**How to avoid:**
- Implement idempotency tracking: maintain a local log of processed employee emails with timestamps and transaction status. Before processing any employee, check if they were already successfully processed.
- Add a confirmation/dry-run mode that extracts and displays the data it would enter, without actually submitting. Let the operator verify the first few records before enabling auto-submit.
- After filling form fields but before clicking "Create Transaction," read back the filled values from the DOM and compare them against the source data. Abort if any mismatch is detected.
- Never click submit-type buttons with retry logic. If the click fails, investigate -- don't retry.
- Implement a "stop on first error" mode for batch processing so one bad record doesn't silently continue corrupting others.

**Warning signs:**
- No local record of what was processed in a batch run.
- The batch script doesn't distinguish between "already processed" and "not yet processed."
- No verification step between filling fields and submitting the transaction.
- Retry logic wrapped around the entire "fill and submit" flow.

**Phase to address:**
Phase 2 (Form entry) and Phase 3 (Batch processing). Idempotency tracking should be designed in Phase 2 and batch safeguards in Phase 3. Dry-run mode is a table-stakes feature for Phase 2.

---

### Pitfall 8: PeopleSoft Navigation Timing -- Clicking Before the Page Is Ready

**What goes wrong:**
PeopleSoft's menu navigation (Homepage -> HR Tasks -> Smart HR Templates -> Smart HR Transactions) involves cascading menus, AJAX loads, and page transitions. Each step may trigger a partial or full page reload. Clicking the next menu item before the current page has finished loading causes navigation failures, menu items not appearing, or clicks landing on the wrong element because the layout shifted during load.

**Why it happens:**
PeopleSoft's UI mixes synchronous postbacks with asynchronous AJAX calls. There is no single reliable "page loaded" signal. The processing indicator (a spinning icon) sometimes appears and sometimes doesn't for AJAX-only operations. Playwright's auto-wait is helpful but not sufficient because PeopleSoft's "actionable" elements may be clickable in the DOM before the underlying JavaScript event handlers are bound.

**How to avoid:**
- After each navigation action, wait for a known element on the destination page/state, not just for the click to succeed. For example, after clicking "Smart HR Transactions," wait for the template dropdown or the search fields to appear.
- Use `page.waitForLoadState('networkidle')` within the iframe as a baseline, but combine it with element-specific waits.
- Build a `navigateTo(path)` helper that encapsulates the wait-click-wait pattern for each step of the PeopleSoft menu hierarchy.
- Add reasonable timeouts (15-30 seconds per navigation step) with descriptive error messages identifying which step failed.

**Warning signs:**
- Navigation that works 80% of the time but fails randomly.
- Errors about elements being "not visible" or "intercepted" during menu clicks.
- The automation lands on unexpected pages after navigation sequences.

**Phase to address:**
Phase 1 (UCPath navigation). Build the navigation helper with proper waits as part of the initial UCPath interaction work.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcoded `sleep()` delays instead of element-based waits | Quick to implement, "fixes" timing issues | Slow execution, still flaky on slow networks, impossible to tune | Never in production. Acceptable only during initial element discovery/debugging |
| Storing extracted data in flat JSON files | Simple, no dependencies | PII on disk unencrypted, no structured querying, grows unwieldy | Only if encrypted and auto-deleted after batch; prefer in-memory only |
| Single monolithic script instead of modular functions | Faster initial development | Impossible to test individual steps, one failure kills entire batch | Only for initial proof-of-concept; refactor before adding batch processing |
| Using `page.waitForTimeout()` for MFA pause | Simple implementation | Fixed timeout wastes time or expires early; no user feedback | MVP only; replace with polling for authenticated state |
| Skipping data readback verification before submit | Saves 1-2 seconds per record | Wrong data silently submitted to payroll system | Never for production use with real HR data |
| XPath selectors with positional indices | Works immediately for the visible page state | Breaks when grid has different number of rows or page layout changes | Never; use ID or attribute-based selectors |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| UCSD SSO (Shibboleth) | Assuming the SSO login page URL is stable -- it may include redirect parameters that change | Match on the SSO page's form elements or domain (`a]4.ucsd.edu` or similar), not the full URL |
| Duo MFA | Waiting for a URL change to detect approval -- intermediate redirects cause false positives | Wait for a definitive post-auth element on the target application page |
| PeopleSoft iframe | Querying `page` directly for form elements | Always go through `page.frameLocator('#ptifrmtgtframe')` for all UCPath content |
| PeopleSoft postback | Caching element references across interactions | Re-locate elements immediately before every interaction |
| Salesforce (ACT CRM) | Using CSS ID selectors on Lightning components with auto-generated IDs | Use `getByRole`, `getByLabel`, or `getByText` locators; use `:has-text()` for disambiguation |
| Salesforce shadow DOM | Standard CSS selectors cannot penetrate shadow DOM boundaries in Lightning components | Use Playwright's built-in shadow DOM piercing (the `>>` selector) or `locator()` which pierces by default |
| Playwright storageState | Saving auth state and committing to git | Add `playwright/.auth/` to `.gitignore`; state files contain session cookies that can impersonate the user |
| PeopleSoft session timeout | Long batch runs timing out mid-process | Monitor for timeout warning dialogs; dismiss them or implement session keep-alive pings |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Fixed sleep delays per field | A 10-employee batch takes 30+ minutes | Replace with element-based waits; only wait as long as necessary | Immediately obvious -- batch processing is painfully slow |
| Full browser restart between employees | Each employee takes 60+ seconds for login overhead | Reuse the authenticated browser session across the batch; only re-authenticate if session expires | At 5+ employees per batch |
| Screenshots on every action (for debugging) | Disk fills up, execution slows down | Log actions textually; only screenshot on errors | At 10+ employees per batch |
| Not reusing SSO session for second system | Double MFA prompts per batch run | Authenticate to both systems at start of batch, then process all employees | Immediately annoying for the operator |
| Loading full page for each employee search | Unnecessary navigation round-trips | Stay on the search results page, clear and re-search without navigating away | At 20+ employees; each round-trip adds 5-10 seconds |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging extracted SSN values in console or file output | PII exposure in terminal history, log files, shared screens | Log only `"SSN extracted: [REDACTED]"` or `"SSN field: OK/FAIL"` |
| Storing credentials in script files instead of `.env` | Credentials committed to git, visible in code | Use `dotenv` for credentials; `.env` in `.gitignore` from first commit |
| Saving Playwright storageState with auth cookies to a shared location | Session hijacking -- anyone with the file can impersonate the user | Save to a temp directory, delete after batch; never commit |
| Screenshots capturing SSN fields on error | PII in image files that may be shared for debugging | Disable auto-screenshots or implement region-masking; mask SSN fields before capture |
| Extracted employee data persisted in unencrypted files | Data breach if machine is compromised | Keep data in memory only; if disk is needed, use OS-level encryption and delete after use |
| Running automation in a shared/multi-user environment | Other users can see browser window, access logs | Run on a dedicated machine or locked session; clear all artifacts after each run |
| Error stack traces containing PII from DOM content | Exception messages may include page HTML with employee data | Catch exceptions at the interaction layer and strip PII before re-throwing |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No progress indication during batch processing | Operator doesn't know if it's working, stuck, or failed | Print status per employee: `"[3/10] Processing john@ucsd.edu... extracting data..."` |
| MFA prompt with no explanation | Operator doesn't know the automation is waiting for them | Clear message: `"Approve the Duo push notification on your phone (waiting up to 120s)..."` |
| Silent failure on one employee corrupts batch | Operator discovers errors only after the entire batch | Stop on first error with clear error message; offer resume capability |
| No dry-run mode | Operator must trust automation with real HR data on first use | Implement `--dry-run` that extracts and displays data without submitting |
| Batch results not summarized | Operator doesn't know which employees succeeded or failed | Print summary table at end: employee, status, any errors |
| No way to process a single employee for testing | Must run full batch to verify anything | Accept single email as well as list; useful for testing and one-off hires |

## "Looks Done But Isn't" Checklist

- [ ] **SSO Login:** Often missing redirect-after-auth handling -- verify the automation reaches the actual UCPath homepage (not an intermediate redirect page or error page)
- [ ] **Duo MFA:** Often missing the denial/timeout case -- verify the script handles "user denied" and "push timed out" without hanging or cascading errors
- [ ] **PeopleSoft Navigation:** Often missing menu load waits -- verify each navigation step waits for the destination content, not just the click to succeed
- [ ] **Data Extraction:** Often missing field-not-found handling -- verify the script handles missing or empty fields gracefully (not all employees may have all fields populated)
- [ ] **Form Entry:** Often missing readback verification -- verify filled values are read back from the DOM and compared to source data before submission
- [ ] **Batch Processing:** Often missing idempotency -- verify re-running a batch doesn't double-process already-completed employees
- [ ] **Session Management:** Often missing timeout detection -- verify the script detects PeopleSoft session timeout and re-authenticates instead of failing with cryptic element-not-found errors
- [ ] **Error Handling:** Often missing cleanup on failure -- verify that if the script fails mid-form, it doesn't leave a half-filled transaction in PeopleSoft
- [ ] **Cross-Domain Auth:** Often missing second-system authentication -- verify that after UCPath login, the ACT CRM portal actually loads authenticated (not showing a login page)

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Duplicate HR transaction submitted | HIGH | Contact UCPC WFA Production to identify and cancel the duplicate; may require manual correction in payroll |
| Wrong data in submitted transaction | HIGH | Contact UCPC WFA Production for correction; document which fields were wrong and provide correct values |
| PII leaked in log files | MEDIUM | Delete log files immediately; assess exposure scope; if committed to git, rewrite history and rotate any exposed credentials |
| Session timeout mid-batch | LOW | Check idempotency log for last successful employee; re-authenticate and resume from the next unprocessed employee |
| Wrong employee record selected | HIGH | If not yet submitted, navigate away and restart for that employee; if submitted, escalate for manual correction |
| Stale element errors breaking batch | LOW | Restart the batch; the idempotency log skips already-processed employees automatically |
| MFA timeout | LOW | Re-run the script; ensure phone is available before starting |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| PeopleSoft postback stale elements | Phase 1: Core framework | All interactions use re-locate pattern; no cached element references in codebase |
| PeopleSoft iframe targeting | Phase 1: UCPath connection | All UCPath locators go through frameLocator helper; zero direct `page.locator()` for UCPath content |
| Dynamic element ID strategy | Phase 2: Form interaction | Selector map exists as configuration; selectors use IDs or attributes, not positional XPath |
| PII leaking into logs | Phase 1: Project setup | `.gitignore` includes all artifact paths; grep codebase for `console.log` on data objects returns zero results |
| Duo MFA pause logic | Phase 1: Authentication | MFA wait handles success, denial, and timeout; tested manually with all three outcomes |
| Cross-domain session assumption | Phase 1: Authentication | Both systems tested in clean Playwright browser context; second auth flow handled if needed |
| Duplicate transaction submission | Phase 2: Form entry | Idempotency log exists; re-running batch skips completed employees; verified with test |
| Navigation timing | Phase 1: UCPath navigation | Each nav step has element-based wait; navigation helper tested independently |
| Data readback verification | Phase 2: Form entry | Verification function reads back every filled field and compares to source before submit |
| Session timeout during batch | Phase 3: Batch processing | Timeout detection implemented; re-auth and resume capability tested with simulated timeout |

## Sources

- [tbensky/selenium-peoplesoft](https://github.com/tbensky/selenium-peoplesoft) -- Real-world PeopleSoft Selenium automation project documenting iframe, timing, and XPath challenges
- [PeopleSoft HTML Element IDs](https://peoplesoftmods.com/tips-and-tricks/peoplesoft-html-element-ids/) -- Undocumented PeopleSoft element ID naming conventions (RECORDNAME_FIELDNAME pattern)
- [Playwright Authentication Docs](https://playwright.dev/docs/auth) -- Official storageState and session persistence documentation
- [Playwright FrameLocator Docs](https://playwright.dev/docs/api/class-framelocator) -- Official iframe handling via frameLocator
- [Playwright Retries Docs](https://playwright.dev/docs/test-retries) -- Retry strategies and soft assertions for batch processing
- [Salesforce Test Automation with Playwright](https://www.testrigtechnologies.com/salesforce-test-automation-with-playwright-challenges-setup-and-proven-strategies/) -- Salesforce-specific automation challenges (Shadow DOM, dynamic IDs, Lightning)
- [Breaking through the Salesforce Shadow DOM](https://www.functionize.com/blog/breaking-through-the-salesforce-shadowdom) -- Shadow DOM encapsulation challenges for automation
- [Jim's PeopleSoft Journal: Unlimited Session Timeout](http://blog.jsmpros.com/2014/07/unlimited-session-timeout.html) -- PeopleSoft session timeout mechanisms and keep-alive
- [Oracle PeopleSoft Portal Technologies](https://docs.oracle.com/cd/E24150_01/pt851h2/eng/psbooks/tprt/htm/tprt12.htm) -- Official documentation on PeopleSoft portal iframe architecture (ptifrmtgtframe)
- [UCPATH System Navigation Guide](https://ucpath.ucsd.edu/_files/training/QR-UCPath-System-Navigation.pdf) -- UCSD UCPath navigation reference
- [How to Keep Sensitive Data Out of Your Logs](https://www.skyflow.com/post/how-to-keep-sensitive-data-out-of-your-logs-nine-best-practices) -- PII logging prevention best practices
- [Handling Stale Element Exceptions](https://www.lambdatest.com/blog/handling-stale-element-exceptions-in-selenium-java/) -- Stale element patterns and prevention in browser automation
- [Playwright SSO Automation](https://medium.com/@biresh.patel/playwright-sso-automation-from-local-poc-to-github-actions-a1913d860ff0) -- SSO authentication flow handling in Playwright

---
*Pitfalls research for: UCPath (PeopleSoft) and ACT CRM (Salesforce) HR browser automation*
*Researched: 2026-03-13*
