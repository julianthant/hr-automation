import type { Frame, Locator, Page } from 'playwright'

/**
 * Wrap a Playwright page so every asynchronous operation races the run's
 * AbortSignal without changing Playwright's arguments. Playwright 1.61 does
 * not consume a generic `signal` option, so injecting one only creates a false
 * sense of cancellation. The race rejects the workflow promptly; `onAbort`
 * lets Session close and replace the now-untrusted page before another item
 * can use it.
 */
export function wrapPageWithSignal(
  page: Page,
  signal: AbortSignal,
  onAbort?: (page: Page) => void,
): Page {
  return createProxy(page, {
    signal,
    rootPage: page,
    onAbort,
    poisoned: false,
    cache: new WeakMap<object, unknown>(),
  })
}

interface ProxyContext {
  signal: AbortSignal
  rootPage: Page
  onAbort?: (page: Page) => void
  poisoned: boolean
  cache: WeakMap<object, unknown>
}

const FACTORY_METHODS = new Set<string>([
  'locator', 'frameLocator',
  'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
  'getByTitle', 'getByTestId', 'getByAltText',
  'filter', 'first', 'last', 'nth', 'and', 'or', 'contentFrame',
  'mainFrame', 'frame', 'frameByUrl', 'parentFrame',
])

const PROXIED_SUBOBJECTS = new Set<string>([
  'keyboard', 'mouse', 'touchscreen', 'mainFrame',
])

const SYNC_METHODS = new Set<string>([
  'url', 'isClosed', 'viewportSize', 'context', 'browser', 'frames',
  ...FACTORY_METHODS,
])

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(signal.reason === undefined ? 'operation aborted' : String(signal.reason))
  error.name = 'AbortError'
  return error
}

function poisonOnce(ctx: ProxyContext): void {
  if (ctx.poisoned) return
  ctx.poisoned = true
  ctx.onAbort?.(ctx.rootPage)
}

function raceWithAbort<T>(promise: PromiseLike<T>, ctx: ProxyContext): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => ctx.signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      poisonOnce(ctx)
      reject(abortReason(ctx.signal))
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function wrapObject(value: object, ctx: ProxyContext): object {
  const cached = ctx.cache.get(value)
  if (cached) return cached
  const proxied = createProxy(value, ctx)
  ctx.cache.set(value, proxied)
  return proxied
}

function wrapFunction(
  target: object,
  method: string,
  fn: (...args: unknown[]) => unknown,
  ctx: ProxyContext,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    if (ctx.signal.aborted && !SYNC_METHODS.has(method)) {
      return Promise.reject(abortReason(ctx.signal))
    }
    const result = fn.apply(target, args)
    if (FACTORY_METHODS.has(method) && result && typeof result === 'object') {
      return wrapObject(result, ctx)
    }
    if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
      return raceWithAbort(result as PromiseLike<unknown>, ctx)
    }
    return result
  }
}

function createProxy<T extends object>(target: T, ctx: ProxyContext): T {
  const handler: ProxyHandler<T> = {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver)
      const value = Reflect.get(t, prop, receiver)
      if (PROXIED_SUBOBJECTS.has(prop) && value && typeof value === 'object') {
        return wrapObject(value, ctx)
      }
      if (typeof value === 'function') {
        return wrapFunction(t, prop, value as (...args: unknown[]) => unknown, ctx)
      }
      return value
    },
    set(t, prop, value, receiver) {
      return Reflect.set(t, prop, value, receiver)
    },
    has(t, prop) {
      return Reflect.has(t, prop)
    },
  }
  return new Proxy(target, handler)
}

export type { Page, Frame, Locator }
