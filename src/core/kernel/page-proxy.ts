import type { Frame, Locator, Page } from 'playwright'

/**
 * Auto-inject a per-run `AbortSignal` into every Playwright method call that
 * accepts a `signal?: AbortSignal` option. Returned by `ctx.page(id)` so a
 * cancel issued mid-`waitForSelector` / `goto` / `click` rejects within ms
 * rather than waiting on the call's declared timeout.
 *
 * Contract 5: this is the unified-cancel mechanism. The kernel's `Stepper`
 * + `mapEscapedHandlerError` translate the resulting AbortError into a
 * `CancelledError` so the terminal row carries `step: "cancelled"` and the
 * daemon's claim loop treats the run as cancelled (browser preserved,
 * post-cancel reset fires, next item claimed) instead of failed.
 *
 * Wrapping rules:
 *   - **Methods with `options?` as the last arg** — merge `{ signal }` into
 *     it. Caller-supplied options win field-by-field; we only fill in
 *     `signal` when the caller didn't pass one. (Caller's signal trumps ours
 *     by design — handlers that wire their own AbortController for finer
 *     grain control don't get clobbered. Operator cancel still works because
 *     the kernel also polls `isCancelRequested` between steps and reroutes
 *     through `Stepper.throwCancelled` at the next boundary.)
 *   - **Locator factories** (`page.locator`, `getByRole`, `getByText`,
 *     `getByLabel`, `getByPlaceholder`, `getByTitle`, `getByTestId`,
 *     `getByAltText`) — return a proxied Locator whose own methods (and
 *     chained `.locator(...)`, `.filter(...)`, `.first()`, etc.) auto-inject
 *     the signal too.
 *   - **Sub-objects** (`keyboard`, `mouse`, `touchscreen`, `frame`,
 *     `mainFrame`) — proxied lazily on access; same wrapping applies to
 *     their methods.
 *   - **Sync getters** (`url`, `title`, `context`, `viewportSize`,
 *     `isClosed`, etc.) — passthrough verbatim.
 *   - **Methods that don't accept a signal option** — passthrough (the
 *     options merge only fires when the original method's last arg looked
 *     like an options object; otherwise the call is untouched).
 *
 * NOT wrapped:
 *   - `page.context()`, `page.browser()` — operating on the BrowserContext or
 *     Browser handle is outside per-run cancellation scope. (Session-level
 *     teardown is the daemon's job, not the kernel's.)
 */
export function wrapPageWithSignal(page: Page, signal: AbortSignal): Page {
  return createProxy(page, signal) as Page
}

// Methods that accept a `signal?: AbortSignal` option. Verified against the
// Playwright Page/Frame/Locator/Keyboard/Mouse type surfaces. Methods missing
// from this set are passthrough — adding one is a one-line addition here
// when Playwright extends a method's options shape.
//
// NOT in this set: `evaluate`, `evaluateHandle`, `$eval`, `$$eval`. These
// take `(pageFunction, arg?)` — no options-object slot. The proxy's
// `mergeSignalIntoArgs` would either (a) append `{signal}` as a phantom
// 2nd arg the page function would receive as its `arg` parameter, or (b)
// merge `{signal}` into a caller-provided plain-object `arg` (AbortSignal
// isn't structurally cloneable across the page boundary, so the call
// would throw). Cancel for evaluate is covered by the stepper's
// between-step `isCancelRequested` probe — long-running evaluate bodies
// are uncommon in this codebase, and operator cancel still surfaces at
// the next step boundary.
const SIGNAL_METHODS = new Set<string>([
  // Page-level actions
  'click', 'dblclick', 'tap', 'hover',
  'fill', 'type', 'press', 'pressSequentially',
  'check', 'uncheck', 'setChecked',
  'selectOption', 'selectText',
  'focus', 'blur',
  'dragAndDrop',
  'setInputFiles',
  // Navigation
  'goto', 'reload', 'goBack', 'goForward',
  // Waits
  'waitForSelector', 'waitForFunction', 'waitForLoadState',
  'waitForURL', 'waitForResponse', 'waitForRequest', 'waitForEvent',
  'waitForNavigation',
  // Capture
  'screenshot', 'pdf',
  // Locator-only methods that also accept signal
  'count', 'all', 'innerText', 'innerHTML',
  'textContent', 'inputValue',
  'getAttribute', 'isChecked', 'isDisabled', 'isEditable',
  'isEnabled', 'isHidden', 'isVisible',
  'boundingBox', 'scrollIntoViewIfNeeded',
  'elementHandle', 'allInnerTexts', 'allTextContents',
  // Keyboard/Mouse
  'down', 'up', 'move', 'wheel', 'insertText',
])

// Locator factories on Page/Frame/Locator. Each returns a Locator that we
// proxy so chained calls stay signal-aware.
const LOCATOR_FACTORIES = new Set<string>([
  'locator', 'frameLocator',
  'getByRole', 'getByText', 'getByLabel',
  'getByPlaceholder', 'getByTitle', 'getByTestId', 'getByAltText',
  // Locator-chaining helpers — these also return Locators
  'filter', 'first', 'last', 'nth', 'and', 'or', 'contentFrame',
])

// Sub-objects on Page/Frame that we want to proxy on access so their method
// calls also auto-inject the signal.
const PROXIED_SUBOBJECTS = new Set<string>([
  'keyboard', 'mouse', 'touchscreen',
  'mainFrame',
])

// Method names whose result is a Frame. Frames have ~the same surface as
// Page (locators, waitForSelector, click, etc.), so proxying them keeps the
// signal-injection invariant across `page.mainFrame().locator(...)`-style
// chains.
const FRAME_RETURNING_METHODS = new Set<string>([
  'mainFrame', 'frame', 'frameByUrl', 'parentFrame',
])

function isOptionsLike(value: unknown): value is Record<string, unknown> {
  // Playwright option objects are plain objects (not arrays / null / class
  // instances). Treating any plain-object last-arg as the options bag matches
  // how Playwright detects it internally.
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function mergeSignalIntoArgs(args: unknown[], signal: AbortSignal): unknown[] {
  if (args.length === 0) {
    return [{ signal }]
  }
  const last = args[args.length - 1]
  if (isOptionsLike(last)) {
    // Don't clobber a caller-provided signal — handlers that wire their own
    // AbortController for finer-grain control still work; operator cancel
    // still surfaces through Stepper's between-step probe.
    if ('signal' in last && last.signal != null) return args
    return [...args.slice(0, -1), { ...last, signal }]
  }
  // Last arg isn't an options bag — append a fresh options bag carrying
  // only `{ signal }`. Playwright treats a missing options arg as `{}`, so
  // appending one is safe and the only mechanism by which a caller that
  // didn't pass options can still get signal injection.
  return [...args, { signal }]
}

function wrapFunction(
  target: object,
  method: string,
  fn: (...args: unknown[]) => unknown,
  signal: AbortSignal,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    let outArgs = args
    if (SIGNAL_METHODS.has(method)) {
      outArgs = mergeSignalIntoArgs(args, signal)
    }
    const result = fn.apply(target, outArgs)

    // Locator factory → wrap the returned Locator so chained calls also
    // inject the signal. Locator factories are synchronous (no await needed).
    if (LOCATOR_FACTORIES.has(method) && result && typeof result === 'object') {
      return createProxy(result, signal)
    }
    // Frame-returning getters (`mainFrame`, `frame`, `parentFrame`) — Frame
    // shares Page's surface; proxy so chained `.locator(...)`/`.click(...)`
    // also wrap.
    if (FRAME_RETURNING_METHODS.has(method) && result && typeof result === 'object') {
      return createProxy(result, signal)
    }
    return result
  }
}

function createProxy<T extends object>(target: T, signal: AbortSignal): T {
  const cache = new WeakMap<object, unknown>()
  const handler: ProxyHandler<T> = {
    get(t, prop, receiver) {
      // Symbol-keyed access (Symbol.iterator, etc.) — passthrough.
      if (typeof prop === 'symbol') {
        return Reflect.get(t, prop, receiver)
      }
      const value = Reflect.get(t, prop, receiver)

      // Sub-objects (keyboard, mouse, touchscreen, mainFrame) — proxy
      // lazily so their methods also inject the signal. mainFrame is also
      // listed in FRAME_RETURNING_METHODS for the function-call path; this
      // covers the getter form where Playwright exposes mainFrame as a
      // property rather than a method.
      if (PROXIED_SUBOBJECTS.has(prop) && value && typeof value === 'object') {
        const cached = cache.get(value as object)
        if (cached) return cached
        const proxied = createProxy(value as object, signal)
        cache.set(value as object, proxied)
        return proxied
      }

      // Methods — wrap so we can inject signal into options and proxy the
      // return value when it's a Locator/Frame.
      if (typeof value === 'function') {
        return wrapFunction(t, prop, value as (...args: unknown[]) => unknown, signal)
      }

      // Sync getters, primitives — passthrough.
      return value
    },
    // Mutations on the page/locator are unusual but we don't want to silently
    // swallow them — passthrough to the underlying target so any side effect
    // is preserved.
    set(t, prop, value, receiver) {
      return Reflect.set(t, prop, value, receiver)
    },
    has(t, prop) {
      return Reflect.has(t, prop)
    },
  }
  // The Proxy preserves T's structural type, which is what `ctx.page(id)`
  // promises (`Promise<Page>`) so workflow handlers see no API change.
  return new Proxy(target, handler) as T
}

// Re-export type aliases so consumers can type-narrow without importing
// directly from 'playwright' when they already imported from this module.
export type { Page, Frame, Locator }
