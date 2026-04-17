# Browser Module

Single file providing Playwright Chromium browser launch with two modes. **Kernel-internal** — workflows should not call `launchBrowser` directly. The kernel's `Session.launch` (in `src/core/session.ts`) owns the launch → tile → auth chain. Use `ctx.page(id)` from handlers, or the escape hatch `ctx.session.page(id)` when you need the raw Page. Legacy workflows (`separations`, `old-kronos-reports`) still call this directly because they predate the kernel.

## `launchBrowser(options?)`

Returns `{ browser, context, page }`.

**Ephemeral mode** (default): `chromium.launch()` + `browser.newContext()`. Fresh context every time, no state persistence. Used for UCPath and CRM workflows.

**Persistent mode** (when `sessionDir` provided): `chromium.launchPersistentContext(sessionDir)`. Reuses login state and cookies across runs. Used for UKG/Kronos workflows.

### Options

- `sessionDir?: string` — enables persistent mode
- `viewport?: { width, height }` — default 1920x1080
- `args?: string[]` — extra Chromium args (e.g., `--window-position`, `--window-size` for tiling)
- `acceptDownloads?: boolean` — default false, must opt-in for download workflows

## Gotchas

- Always headed (`headless: false`) — no headless option exposed. Requires display.
- In persistent mode, `browser` is `null` — callers must check before calling `browser.close()`
- Existing pages from prior persistent sessions may have stale state
- Multiple workers using same `sessionDir` will conflict — use unique per-worker dirs (e.g., `ukg_session_worker1`)
- `acceptDownloads` must be explicitly `true` for kronos report downloads

## Lessons Learned

*(Add entries here when browser launch/session bugs are fixed — document root cause and fix)*
