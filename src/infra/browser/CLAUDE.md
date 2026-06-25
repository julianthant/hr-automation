# Browser Module

Single file providing Playwright Chromium browser launch with two modes plus a small retrying navigation helper. **Mostly kernel-internal** - workflows should not call `launchBrowser` directly. The kernel's `Session.launch` (in `src/core/kernel/session.ts`) owns the launch -> tile -> auth chain. Use `ctx.page(id)` from handlers, or the escape hatch `ctx.session.page(id)` when you need the raw Page.

Direct callers should stay rare and explicit. Current direct callers outside the kernel are the sharepoint download primitive (download-enabled launch), the legacy `src/cli.ts` probes, and `src/scripts/debug/kronos.ts` for selector mapping/debugging.

## `launchBrowser(options?)`

Returns `{ browser, context, page }`.

**Ephemeral mode** (default): `chromium.launch()` + `browser.newContext()`. Fresh context every time, no state persistence. Used for UCPath and CRM workflows.

**Persistent mode** (when `sessionDir` provided): `chromium.launchPersistentContext(sessionDir)`. Reuses login state and cookies across runs. Used for UKG/Kronos workflows.

### Options

- `sessionDir?: string` — enables persistent mode
- `viewport?: { width, height } | null` - default `null`, so the viewport tracks the OS window size. Pass a fixed size only when the workflow needs fixed rendering.
- `args?: string[]` — extra Chromium args (e.g., `--window-position`, `--window-size` for tiling)
- `acceptDownloads?: boolean` — default false, must opt-in for download workflows
- `headless?: boolean` — default false (headed). Opt-in for unattended integration tests (`tests/live/`); production never sets it. The CDP WebAuthn hands-off Duo path works under headless Chromium.

## `gotoWithRetry(page, url, verify?, retries?, timeout?)`

Retrying navigation helper for transient "site didn't load" failures. Re-runs `page.goto` (a fresh navigation ≈ a refresh) up to `retries` times (default `DEFAULT_NAVIGATION_RETRIES` = **10**) with a ~6s pause between attempts, failing only after all attempts are exhausted (operator policy 2026-06-24: "refresh up to 10× on a 5–10s interval, only fail if it still won't load"). Retries fire on `RETRYABLE_NAVIGATION_PATTERNS` — chromium net errors, **navigation timeouts** (`page.goto … Timeout`), `chrome-error` landings, and a failed `verify` (the element may not have rendered yet). A non-loading error escapes immediately. Optional `verify` can be a locator or predicate. Keep this as infra-level navigation plumbing; workflow-specific "page is ready" semantics still belong in system/workflow code.

## Gotchas

- Headed by default; pass `headless: true` (opt-in, tests only — production omits it) for unattended runs. Headed mode requires a display.
- In persistent mode, `browser` is `null` — callers must check before calling `browser.close()`
- Existing pages from prior persistent sessions may have stale state
- Multiple workers using same `sessionDir` will conflict — use unique per-worker dirs (e.g., `ukg_session_worker1`)
- `acceptDownloads` must be explicitly `true` for report/sharepoint downloads

## Lessons Learned

- **2026-06-24: `gotoWithRetry` did NOT retry navigation timeouts — one slow load failed the whole run.** `RETRYABLE_NAVIGATION_PATTERNS` only listed `ERR_NETWORK`/`chrome-error`/`ERR_CONNECTION`/`verification failed`, so a `page.goto … Timeout 15000ms exceeded` (the mapped "Page navigation timed out" message) matched nothing and was thrown on **attempt 1** with no retry — a single slow Kuali Build load failed a separation outright (doc #4322). Fix: added timeout/net patterns (`timeout`, `timed out`, `net::err`, `err_timed_out`, …, matched case-insensitively), bumped the default retries 3 → **10** (`DEFAULT_NAVIGATION_RETRIES`), and standardized the pause at ~6s — operator policy is "refresh up to 10× on a 5–10s interval, only fail if it still won't load." `src/infra/auth/login.ts`'s UKG nav keeps its **explicit** `retries=3, timeout=60_000` override (a deliberately slow SPA — 10×60s would be a 10-min hang); the new default applies to callers that don't override (Kuali, the duo-enroll script). Pinned by `tests/unit/infra/browser/launch.test.ts`.
