import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramNotifier,
  formatAuthEventMessage,
  type AuthEvent,
  type FetchFn,
} from "../../../src/auth/telegram-notify.js";

function makeRecorder(): {
  calls: Array<{ url: string; init?: RequestInit }>;
  fetchFn: FetchFn;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    },
  };
}

const sampleEvent: AuthEvent = {
  kind: "duo-waiting",
  systemLabel: "UCPath",
  workflow: "oath-signature",
  runId: "abc-123",
};

describe("createTelegramNotifier — env-var gating", () => {
  it("no-ops when token is missing", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: undefined,
      chatIdValue: "987654321",
    });
    await notify(sampleEvent);
    assert.equal(calls.length, 0);
  });

  it("no-ops when chat_id is missing", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "111:AAA",
      chatIdValue: undefined,
    });
    await notify(sampleEvent);
    assert.equal(calls.length, 0);
  });

  it("no-ops when both are empty strings", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "",
      chatIdValue: "",
    });
    await notify(sampleEvent);
    assert.equal(calls.length, 0);
  });

  it("calls fetch when both env values are set", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "111:AAA",
      chatIdValue: "987654321",
    });
    await notify(sampleEvent);
    assert.equal(calls.length, 1);
  });
});

describe("formatAuthEventMessage", () => {
  const base: AuthEvent = {
    kind: "duo-waiting",
    systemLabel: "UCPath",
    workflow: "oath-signature",
  };

  it("starts with 🔐 for duo-waiting", () => {
    const msg = formatAuthEventMessage(base);
    assert.match(msg, /^🔐/);
  });

  it("starts with ✅ for duo-approved", () => {
    const msg = formatAuthEventMessage({ ...base, kind: "duo-approved" });
    assert.match(msg, /^✅/);
  });

  it("starts with ⌛ for duo-timeout", () => {
    const msg = formatAuthEventMessage({ ...base, kind: "duo-timeout" });
    assert.match(msg, /^⌛/);
  });

  it("starts with 🔄 for duo-resent", () => {
    const msg = formatAuthEventMessage({ ...base, kind: "duo-resent" });
    assert.match(msg, /^🔄/);
  });

  it("includes systemLabel", () => {
    const msg = formatAuthEventMessage(base);
    assert.match(msg, /UCPath/);
  });

  it("includes workflow", () => {
    const msg = formatAuthEventMessage(base);
    assert.match(msg, /oath-signature/);
  });

  it("includes runId when present", () => {
    const msg = formatAuthEventMessage({ ...base, runId: "abcd-1234" });
    assert.match(msg, /abcd-1234/);
  });

  it("omits runId line when absent", () => {
    const msg = formatAuthEventMessage(base);
    assert.doesNotMatch(msg, /Run:/);
  });

  it("includes detail when present", () => {
    const msg = formatAuthEventMessage({ ...base, detail: "approve on phone" });
    assert.match(msg, /approve on phone/);
  });

  it("escapes HTML special chars in workflow / systemLabel", () => {
    const msg = formatAuthEventMessage({
      ...base,
      systemLabel: "UC<Path>",
      workflow: "oath & signature",
    });
    assert.doesNotMatch(msg, /<Path>/);
    assert.match(msg, /UC&lt;Path&gt;/);
    assert.match(msg, /oath &amp; signature/);
  });
});
