import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramNotifier,
  formatAuthEventMessage,
  notifyAuthEvent,
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

describe("createTelegramNotifier — HTTP request shape", () => {
  it("POSTs to the right Telegram bot endpoint", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await notify(sampleEvent);
    assert.equal(calls[0].url, "https://api.telegram.org/bot111:AAA/sendMessage");
    assert.equal(calls[0].init?.method, "POST");
  });

  it("uses HTML parse_mode and includes chat_id + text in body", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await notify(sampleEvent);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.chat_id, "987");
    assert.equal(body.parse_mode, "HTML");
    assert.match(body.text, /UCPath/);
  });

  it("sends Content-Type: application/json", async () => {
    const { calls, fetchFn } = makeRecorder();
    const notify = createTelegramNotifier({
      fetchFn,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await notify(sampleEvent);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
  });
});

describe("createTelegramNotifier — error swallowing", () => {
  it("does not throw when fetchFn rejects (network error)", async () => {
    const failing: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const notify = createTelegramNotifier({
      fetchFn: failing,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await assert.doesNotReject(notify(sampleEvent));
  });

  it("does not throw on HTTP 401 (invalid token)", async () => {
    const fail401: FetchFn = async () =>
      new Response('{"ok":false,"error_code":401}', { status: 401 });
    const notify = createTelegramNotifier({
      fetchFn: fail401,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await assert.doesNotReject(notify(sampleEvent));
  });

  it("does not throw on HTTP 429 (rate limited)", async () => {
    const fail429: FetchFn = async () =>
      new Response('{"ok":false,"error_code":429}', { status: 429 });
    const notify = createTelegramNotifier({
      fetchFn: fail429,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await assert.doesNotReject(notify(sampleEvent));
  });

  it("does not throw when AbortSignal fires (slow fetch)", async () => {
    // Wait for the abort signal then translate to a thrown error the way
    // real `fetch` does on AbortSignal.timeout. Real production timeout is
    // 5s — for the test we override to 50ms via a custom fetchFn that
    // honors the signal but cuts out fast.
    const slow: FetchFn = async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(new Error("aborted"));
            return;
          }
          sig.addEventListener("abort", () => reject(new Error("aborted")));
          // Don't add a fallback timer — let the real AbortSignal.timeout
          // (5s) fire. Test deliberately exercises the timeout path.
        }
      });
      throw new Error("unreachable");
    };
    const notify = createTelegramNotifier({
      fetchFn: slow,
      tokenValue: "111:AAA",
      chatIdValue: "987",
    });
    await assert.doesNotReject(notify(sampleEvent));
  });
});

describe("notifyAuthEvent — default instance reads process.env", () => {
  it("no-ops when env vars are absent (covers production default path)", async () => {
    const oldT = process.env.TELEGRAM_BOT_TOKEN;
    const oldC = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      await assert.doesNotReject(notifyAuthEvent(sampleEvent));
    } finally {
      if (oldT !== undefined) process.env.TELEGRAM_BOT_TOKEN = oldT;
      if (oldC !== undefined) process.env.TELEGRAM_CHAT_ID = oldC;
    }
  });
});
