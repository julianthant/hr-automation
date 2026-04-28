import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramNotifier,
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
