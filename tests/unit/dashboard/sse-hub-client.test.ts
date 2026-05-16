import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { SseHub } from "../../../src/dashboard/lib/sse-hub.js";

// ---------------------------------------------------------------------------
// Minimal in-process EventSource mock
// ---------------------------------------------------------------------------

interface MockEventSourceInstance {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  closed: boolean;
  close(): void;
}

let constructorCallCount = 0;
let lastInstance: MockEventSourceInstance | null = null;
const allInstances: MockEventSourceInstance[] = [];

class MockEventSource implements MockEventSourceInstance {
  static CLOSED = 2;
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(url: string) {
    this.url = url;
    constructorCallCount++;
    lastInstance = this;
    allInstances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function flushMicrotasks(): Promise<void> {
  // Two levels of Promise resolution to ensure queueMicrotask callbacks fire.
  return Promise.resolve().then(() => Promise.resolve());
}

// ---------------------------------------------------------------------------
// Test lifecycle — install/restore the mock per test
// ---------------------------------------------------------------------------

const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;
let hub: SseHub;

beforeEach(() => {
  constructorCallCount = 0;
  lastInstance = null;
  allInstances.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  hub = new SseHub();
});

afterEach(() => {
  hub.__resetForTests();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = originalWindow;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("1. subscribe returns an unsubscribe function", () => {
  const unsub = hub.subscribe("entries", {}, () => {});
  assert.equal(typeof unsub, "function");
});

test("2. two subscribe calls in one microtask → exactly one EventSource constructor call", async () => {
  hub.subscribe("entries", {}, () => {});
  hub.subscribe("logs", { id: "x" }, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);
});

test("3. subscribe then unsubscribe within the same microtask → zero EventSource opens", async () => {
  const unsub = hub.subscribe("entries", {}, () => {});
  unsub();
  await flushMicrotasks();
  assert.equal(constructorCallCount, 0);
});

test("4. after the microtask the URL contains the encoded subs JSON with both subscriptions", async () => {
  hub.subscribe("entries", { workflow: "onboarding" }, () => {});
  hub.subscribe("logs", { id: "a@b.com" }, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);
  const url = lastInstance!.url;
  assert.ok(url.startsWith("/events/hub?subs="), `URL should start with /events/hub?subs=, got: ${url}`);
  const decoded = JSON.parse(decodeURIComponent(url.slice("/events/hub?subs=".length))) as unknown[];
  assert.equal(decoded.length, 2);
  const topics = (decoded as Array<{ topic: string }>).map((s) => s.topic);
  assert.ok(topics.includes("entries"), "entries topic missing");
  assert.ok(topics.includes("logs"), "logs topic missing");
});

test("4b. Vite dev dashboard connects EventSource directly to the Hono backend", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    location: { protocol: "http:", hostname: "localhost", port: "5173" },
  };

  hub.subscribe("entries", { workflow: "active-check" }, () => {});
  await flushMicrotasks();

  assert.equal(constructorCallCount, 1);
  assert.ok(
    lastInstance!.url.startsWith("http://localhost:3838/events/hub?subs="),
    `expected EventSource to bypass the Vite proxy, got: ${lastInstance!.url}`,
  );
});

test("5. envelope dispatch: listener fires with correct data and undefined event", async () => {
  const received: Array<{ data: unknown; event: unknown }> = [];
  const unsub = hub.subscribe("entries", {}, (data, event) => {
    received.push({ data, event });
  });
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);

  // The envelope's `sub` field must match the id assigned to this subscription.
  // We read it from the encoded URL.
  const url = lastInstance!.url;
  const decoded = JSON.parse(decodeURIComponent(url.slice("/events/hub?subs=".length))) as Array<{ id: string }>;
  const subId = decoded[0].id;

  lastInstance!.onmessage!({ data: JSON.stringify({ sub: subId, data: { hello: "world" } }) });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, { hello: "world" });
  assert.equal(received[0].event, undefined);

  unsub();
});

test("6. envelope with event field: listener receives data and the event string", async () => {
  const received: Array<{ data: unknown; event: unknown }> = [];
  const unsub = hub.subscribe("captureSessions", {}, (data, event) => {
    received.push({ data, event });
  });
  await flushMicrotasks();

  const url = lastInstance!.url;
  const decoded = JSON.parse(decodeURIComponent(url.slice("/events/hub?subs=".length))) as Array<{ id: string }>;
  const subId = decoded[0].id;

  lastInstance!.onmessage!({
    data: JSON.stringify({ sub: subId, data: { sessions: [] }, event: "session-list" }),
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, { sessions: [] });
  assert.equal(received[0].event, "session-list");

  unsub();
});

test("7. malformed envelope → no throw, no listener called", async () => {
  let listenerCalled = false;
  const unsub = hub.subscribe("entries", {}, () => {
    listenerCalled = true;
  });
  await flushMicrotasks();

  assert.doesNotThrow(() => {
    lastInstance!.onmessage!({ data: "not json" });
  });
  assert.equal(listenerCalled, false);

  unsub();
});

test("8. envelope for an unknown sub id → no throw, no listener called", async () => {
  let listenerCalled = false;
  const unsub = hub.subscribe("entries", {}, () => {
    listenerCalled = true;
  });
  await flushMicrotasks();

  // Use a sub id that does not exist.
  assert.doesNotThrow(() => {
    lastInstance!.onmessage!({ data: JSON.stringify({ sub: "s9999", data: {} }) });
  });
  assert.equal(listenerCalled, false);

  unsub();
});

test("9. onError callback fires when EventSource onerror triggers; fires once per sub", async () => {
  const errors1: number[] = [];
  const errors2: number[] = [];

  const unsub1 = hub.subscribe("entries", {}, () => {}, () => errors1.push(1));
  const unsub2 = hub.subscribe("logs", {}, () => {}, () => errors2.push(1));
  await flushMicrotasks();

  lastInstance!.onerror!();

  assert.equal(errors1.length, 1);
  assert.equal(errors2.length, 1);

  unsub1();
  unsub2();
});

test("9b. CLOSED EventSource errors rebuild the hub connection", async () => {
  hub.subscribe("entries", {}, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);
  const firstInstance = lastInstance!;

  firstInstance.readyState = MockEventSource.CLOSED;
  firstInstance.onerror!();
  await flushMicrotasks();

  assert.equal(constructorCallCount, 2);
  assert.equal(firstInstance.closed, true);
  assert.notEqual(lastInstance, firstInstance);
});

test("10. unsubscribing the last sub closes the EventSource and sets es to null", async () => {
  const unsub = hub.subscribe("entries", {}, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);
  const instance = lastInstance!;
  assert.equal(instance.closed, false);

  unsub();
  await flushMicrotasks();

  assert.equal(instance.closed, true);
  // Access private field via type cast for test verification.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((hub as any).es, null);
});

test("12. listener that throws does not prevent a second sub's listener from being called", async () => {
  const received: unknown[] = [];

  // s1 throws on every message
  hub.subscribe("entries", {}, () => {
    throw new Error("s1 deliberate throw");
  });
  // s2 records all deliveries
  hub.subscribe("logs", { id: "x" }, (data) => {
    received.push(data);
  });
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);

  // Read sub ids from the encoded URL
  const url = lastInstance!.url;
  const decoded = JSON.parse(decodeURIComponent(url.slice("/events/hub?subs=".length))) as Array<{
    id: string;
    topic: string;
  }>;
  const s2Id = decoded.find((s) => s.topic === "logs")!.id;

  // Deliver an envelope to s2; the hub must not crash from s1's throw
  assert.doesNotThrow(() => {
    lastInstance!.onmessage!({
      data: JSON.stringify({ sub: s2Id, data: { hello: "world" } }),
    });
  });

  assert.equal(received.length, 1, "s2 listener should receive the message");
  assert.deepEqual(received[0], { hello: "world" });
});

test("13. listener error reaches console.error with the topic name included", async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  try {
    hub.subscribe("entries", {}, () => {
      throw new Error("deliberate");
    });
    await flushMicrotasks();

    const url = lastInstance!.url;
    const decoded = JSON.parse(decodeURIComponent(url.slice("/events/hub?subs=".length))) as Array<{
      id: string;
    }>;
    const subId = decoded[0].id;

    lastInstance!.onmessage!({ data: JSON.stringify({ sub: subId, data: {} }) });

    assert.equal(errors.length, 1, "console.error should be called once");
    assert.ok(
      String(errors[0]).includes("entries"),
      `error message should include the topic name 'entries', got: ${errors[0]}`,
    );
  } finally {
    console.error = originalError;
  }
});

test("11. subscribing again after close opens a fresh EventSource on the next microtask", async () => {
  const unsub1 = hub.subscribe("entries", {}, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1);

  unsub1();
  await flushMicrotasks();
  assert.equal(constructorCallCount, 1); // still 1 — just closed

  hub.subscribe("logs", {}, () => {});
  await flushMicrotasks();
  assert.equal(constructorCallCount, 2); // fresh EventSource opened
});
