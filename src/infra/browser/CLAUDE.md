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

Retrying navigation helper for transient network/chrome-error failures. Optional `verify` can be a locator or predicate. Keep this as infra-level navigation plumbing; workflow-specific "page is ready" semantics still belong in system/workflow code.

## Gotchas

- Headed by default; pass `headless: true` (opt-in, tests only — production omits it) for unattended runs. Headed mode requires a display.
- In persistent mode, `browser` is `null` — callers must check before calling `browser.close()`
- Existing pages from prior persistent sessions may have stale state
- Multiple workers using same `sessionDir` will conflict — use unique per-worker dirs (e.g., `ukg_session_worker1`)
- `acceptDownloads` must be explicitly `true` for report/sharepoint downloads

## Lessons Learned

*(Add entries here when browser launch/session bugs are fixed — document root cause and fix)*
