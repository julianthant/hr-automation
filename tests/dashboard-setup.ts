import { afterEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.).
// This is the convention break the isolated dashboard pool exists to quarantine.
expect.extend(matchers);

// Unmount React trees + reset jsdom between tests so module state and the DOM
// don't bleed across cases.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------
// Several dashboard hooks (`useQueueDepth`, `useDaemons`) poll JSON endpoints
// via `fetch`. jsdom provides no network, and the hooks tolerate failure (they
// `catch` and keep their empty defaults). Stub `fetch` to a rejecting no-op so
// those polls resolve deterministically to "nothing alive / 0 queued" instead
// of throwing an unhandled rejection or hitting a real socket. Action buttons
// only call `fetch`/dispatch on click, which these component tests don't fire.
if (!("fetch" in globalThis) || typeof globalThis.fetch !== "function") {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: () => Promise.reject(new Error("fetch disabled in dashboard component tests")),
  });
}

// ---------------------------------------------------------------------------
// Minimal EventSource mock
// ---------------------------------------------------------------------------
// jsdom has no EventSource. None of the three components under test open one
// directly, but providing a no-op class keeps any transitive import that
// references the global from exploding. Mirrors the MockEventSource shape used
// by `tests/unit/dashboard/sse-hub-client.test.ts`.
if (!("EventSource" in globalThis)) {
  class MockEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    url: string;
    readyState = 0;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onopen: ((ev: Event) => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = MockEventSource.CLOSED;
    }
  }
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
}
