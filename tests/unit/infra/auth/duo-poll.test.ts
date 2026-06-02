import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  DUO_POLL_INTERVAL_MS,
  DUO_PRE_CHECK_MS,
  DUO_PRE_CHECK_INTERVAL_MS,
  attemptDuoSmsPasscode,
  buildDuoResentDetail,
  buildDuoWaitingDetail,
  extractDuoVerificationCode,
  pollDuoApproval,
  readDuoVerificationCodeWhenVisible,
  type DuoPollOptions,
} from "../../../../src/infra/auth/duo-poll.js";
import type { ImessagePasscodeReader } from "../../../../src/infra/auth/imessage-passcode.js";

describe("DuoPollOptions interface", () => {
  it("accepts string successUrlMatch", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kronos.net",
    };
    assert.equal(typeof opts.successUrlMatch, "string");
  });

  it("accepts function successUrlMatch", () => {
    const fn = (url: string) => url.includes("universityofcalifornia.edu");
    const opts: DuoPollOptions = {
      successUrlMatch: fn,
    };
    assert.equal(typeof opts.successUrlMatch, "function");
    assert.equal((opts.successUrlMatch as (url: string) => boolean)("https://universityofcalifornia.edu/"), true);
    assert.equal((opts.successUrlMatch as (url: string) => boolean)("https://duosecurity.com/"), false);
  });

  it("accepts optional timeoutSeconds with default-compatible value", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
      timeoutSeconds: 180,
    };
    assert.equal(opts.timeoutSeconds, 180);
  });

  it("timeoutSeconds is optional", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "mykronos.com/wfd",
    };
    assert.equal(opts.timeoutSeconds, undefined);
  });

  it("accepts optional successCheck async function", () => {
    const check = async () => true;
    const opts: DuoPollOptions = {
      successUrlMatch: "kronos.net",
      successCheck: check,
    };
    assert.equal(typeof opts.successCheck, "function");
  });

  it("accepts optional postApproval async hook", () => {
    const hook = async () => {};
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
      postApproval: hook,
    };
    assert.equal(typeof opts.postApproval, "function");
  });

  it("successCheck is optional", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
    };
    assert.equal(opts.successCheck, undefined);
  });

  it("postApproval is optional", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
    };
    assert.equal(opts.postApproval, undefined);
  });

  it("function successUrlMatch for UCPath pattern", () => {
    const fn = (url: string) =>
      url.includes("universityofcalifornia.edu") && !url.includes("duosecurity");
    const opts: DuoPollOptions = { successUrlMatch: fn };
    const match = opts.successUrlMatch as (url: string) => boolean;
    assert.equal(match("https://ucphrprdpub.universityofcalifornia.edu/home"), true);
    assert.equal(match("https://api-prod.oldduo.duosecurity.com/universityofcalifornia.edu"), false);
  });

  it("function successUrlMatch for ACT CRM pattern", () => {
    const fn = (url: string) =>
      (url.includes("act-crm.my.site.com") || url.includes("crm.ucsd.edu")) &&
      !url.includes("login");
    const opts: DuoPollOptions = { successUrlMatch: fn, timeoutSeconds: 60 };
    const match = opts.successUrlMatch as (url: string) => boolean;
    assert.equal(match("https://act-crm.my.site.com/dashboard"), true);
    assert.equal(match("https://crm.ucsd.edu/hr"), true);
    assert.equal(match("https://act-crm.my.site.com/login"), false);
    assert.equal(opts.timeoutSeconds, 60);
  });

  it("accepts optional pollIntervalMs override", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
      pollIntervalMs: 100,
    };
    assert.equal(opts.pollIntervalMs, 100);
  });

  it("pollIntervalMs is optional", () => {
    const opts: DuoPollOptions = { successUrlMatch: "kualibuild" };
    assert.equal(opts.pollIntervalMs, undefined);
  });

  it("accepts optional preCheckMs override", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
      preCheckMs: 0,
    };
    assert.equal(opts.preCheckMs, 0);
  });

  it("accepts optional preCheckIntervalMs override", () => {
    const opts: DuoPollOptions = {
      successUrlMatch: "kualibuild",
      preCheckIntervalMs: 50,
    };
    assert.equal(opts.preCheckIntervalMs, 50);
  });

  it("preCheckMs and preCheckIntervalMs are optional", () => {
    const opts: DuoPollOptions = { successUrlMatch: "kualibuild" };
    assert.equal(opts.preCheckMs, undefined);
    assert.equal(opts.preCheckIntervalMs, undefined);
  });
});

describe("DUO_POLL_INTERVAL_MS constant", () => {
  it("is fixed at 5000ms — matches the 2026-04-28 cluster A spec", () => {
    assert.equal(DUO_POLL_INTERVAL_MS, 5_000);
  });
});

describe("DUO_PRE_CHECK_MS constant", () => {
  it("is 2000ms — covers the cached-trust SAML redirect window", () => {
    assert.equal(DUO_PRE_CHECK_MS, 2_000);
  });

  it("DUO_PRE_CHECK_INTERVAL_MS is 500ms — finer than the main poll cadence", () => {
    assert.equal(DUO_PRE_CHECK_INTERVAL_MS, 500);
    assert.ok(DUO_PRE_CHECK_INTERVAL_MS < DUO_POLL_INTERVAL_MS);
  });
});

describe("Duo verification code helpers", () => {
  it("extracts the visible Duo Mobile verification code from page text", () => {
    const text = [
      "UC San Diego",
      "Enter code in Duo Mobile",
      "Verify it's you by entering this verification code in the Duo Mobile app...",
      "7078",
      "Sent to \"iOS\" (•••-•••-9464)",
    ].join("\n");

    assert.equal(extractDuoVerificationCode(text), "7078");
  });

  it("does not treat the masked phone suffix as a Duo verification code", () => {
    const text = "Sent to \"iOS\" (•••-•••-9464)";

    assert.equal(extractDuoVerificationCode(text), undefined);
  });

  it("builds a Telegram detail that carries the Duo code when available", () => {
    assert.equal(buildDuoWaitingDetail("7078"), "Enter Duo code 7078 in Duo Mobile");
  });

  it("keeps the push-approval detail when no Duo code is visible", () => {
    assert.equal(buildDuoWaitingDetail(undefined), "Approve on your phone");
  });

  it("carries the last visible Duo code into the push resent Telegram detail", () => {
    assert.equal(buildDuoResentDetail(undefined, "3158"), "Enter Duo code 3158 in Duo Mobile");
  });

  it("prefers a newly visible Duo code over the previous resend fallback", () => {
    assert.equal(buildDuoResentDetail("7078", "3158"), "Enter Duo code 7078 in Duo Mobile");
  });

  it("keeps the short push resent detail when no Duo code has ever been visible", () => {
    assert.equal(buildDuoResentDetail(undefined, undefined), "Push resent");
  });

  it("waits briefly for the initial Duo code before building the first Telegram message", async () => {
    let reads = 0;
    const page = {
      locator: () => ({
        innerText: async () => {
          reads += 1;
          return reads < 3
            ? "UC San Diego\nEnter code in Duo Mobile"
            : "UC San Diego\nEnter code in Duo Mobile\n0203\nSent to \"iOS\" (•••-•••-9464)";
        },
      }),
      waitForTimeout: async () => {},
    } as unknown as import("playwright").Page;

    const code = await readDuoVerificationCodeWhenVisible(page, {
      timeoutMs: 500,
      intervalMs: 25,
    });

    assert.equal(code, "0203");
    assert.equal(buildDuoWaitingDetail(code), "Enter Duo code 0203 in Duo Mobile");
  });

  it("aborts an in-progress Duo poll instead of waiting for the poll cadence", async () => {
    const controller = new AbortController();
    const emptyLocator = {
      count: async () => 0,
      first() { return this; },
      or() { return this; },
      click: async () => {},
      innerText: async () => "UC San Diego\nEnter code in Duo Mobile",
    };
    const page = {
      url: () => "https://api-prod.duosecurity.com/frame",
      locator: () => emptyLocator,
      getByRole: () => emptyLocator,
      getByText: () => emptyLocator,
      waitForTimeout: async () => {},
    } as unknown as import("playwright").Page;
    setTimeout(() => controller.abort(new Error("stop requested during Duo")), 25);

    await assert.rejects(
      () => Promise.race([
        pollDuoApproval(page, {
          successUrlMatch: "done",
          timeoutSeconds: 60,
          preCheckMs: 0,
          initialCodeWaitMs: 0,
          pollIntervalMs: 5_000,
          abortSignal: controller.signal,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Duo poll did not abort")), 250)),
      ]),
      /stop requested during Duo|aborted/i,
    );
  });
});

// ─── iMessage SMS-passcode path ───────────────────────────────────────────────

function fakeReader(opts: {
  enabled?: boolean;
  code?: string;
}): ImessagePasscodeReader {
  return {
    isEnabled: () => opts.enabled ?? true,
    readFreshPasscode: () => opts.code,
  };
}

/**
 * Builds a fake Playwright page for the Duo Universal Prompt. Each selector
 * call is tagged by intent (otherOptions / smsFactor / tryAgain / trust / input
 * / verify / body); `.or()` merges tag lists; `.count()` reflects whether the
 * tag is "present" per `cfg`; `.click()`/`.fill()` record interactions. `url()`
 * flips to `successUrl` once the verify button is clicked.
 */
function makeDuoPromptPage(cfg: {
  otherOptions?: boolean;
  smsFactor?: boolean;
  successUrl?: string;
  pendingUrl?: string;
}) {
  const clicks: string[] = [];
  const fills: { tag: string; value: string }[] = [];
  const flags = { verified: false, innerTextCalled: false };

  const present = (tag: string): boolean => {
    if (tag === "otherOptions") return cfg.otherOptions ?? false;
    if (tag === "smsFactor") return cfg.smsFactor ?? false;
    if (tag === "tryAgain" || tag === "trust") return false;
    return true; // input + verify + body always resolvable
  };

  const tagFor = (name?: RegExp | string, sel?: string): string => {
    const n = name instanceof RegExp ? name.source : typeof name === "string" ? name : "";
    if (/other options/i.test(n)) return "otherOptions";
    if (/text message passcode/i.test(n)) return "smsFactor";
    if (/try again/i.test(n) || sel?.includes("Try Again")) return "tryAgain";
    if (/Yes, this is my device/i.test(n)) return "trust";
    if (/passcode/i.test(n) || sel?.includes("one-time-code") || sel?.includes('name="passcode"'))
      return "input";
    if (/verify|log/i.test(n) || sel?.includes('type="submit"')) return "verify";
    if (sel === "body") return "body";
    return "unknown";
  };

  const makeLoc = (tags: string[]) => {
    const loc = {
      __tags: tags,
      or: (other: { __tags: string[] }) => makeLoc([...tags, ...other.__tags]),
      first() {
        return loc;
      },
      count: async () => tags.filter(present).length,
      click: async () => {
        const tag = tags.find(present) ?? tags[0];
        clicks.push(tag);
        if (tag === "verify") flags.verified = true;
      },
      fill: async (value: string) => {
        fills.push({ tag: tags.find(present) ?? tags[0], value });
      },
      innerText: async () => {
        flags.innerTextCalled = true;
        return "";
      },
    };
    return loc;
  };

  const page = {
    url: () => (flags.verified ? cfg.successUrl ?? "" : cfg.pendingUrl ?? ""),
    getByRole: (_role: string, o?: { name?: RegExp | string }) => makeLoc([tagFor(o?.name)]),
    getByText: (t: RegExp | string) => makeLoc([tagFor(t)]),
    locator: (sel: string) => makeLoc([tagFor(undefined, sel)]),
  } as unknown as Page;

  return { page, clicks, fills, flags };
}

describe("attemptDuoSmsPasscode", () => {
  it("returns false and never touches the page when the reader is disabled", async () => {
    let touched = false;
    const page = new Proxy(
      {},
      {
        get() {
          touched = true;
          throw new Error("page must not be touched when SMS path is disabled");
        },
      },
    ) as unknown as Page;
    const result = await attemptDuoSmsPasscode(page, fakeReader({ enabled: false }));
    assert.equal(result, false);
    assert.equal(touched, false);
  });

  it("clicks the SMS factor, fills the code, and verifies when a code arrives", async () => {
    const { page, clicks, fills } = makeDuoPromptPage({ otherOptions: false, smsFactor: true });
    const result = await attemptDuoSmsPasscode(page, fakeReader({ enabled: true, code: "1234567" }), {
      waitMs: 1_000,
      intervalMs: 10,
    });
    assert.equal(result, true);
    assert.deepEqual(clicks, ["smsFactor", "verify"]);
    assert.deepEqual(fills, [{ tag: "input", value: "1234567" }]);
  });

  it("clicks 'Other options' first when it is present", async () => {
    const { page, clicks } = makeDuoPromptPage({ otherOptions: true, smsFactor: true });
    await attemptDuoSmsPasscode(page, fakeReader({ enabled: true, code: "7654321" }), {
      waitMs: 1_000,
      intervalMs: 10,
    });
    assert.deepEqual(clicks, ["otherOptions", "smsFactor", "verify"]);
  });

  it("returns false (no submit) when the 'Text message passcode' option is absent", async () => {
    const { page, clicks, fills } = makeDuoPromptPage({ otherOptions: false, smsFactor: false });
    const result = await attemptDuoSmsPasscode(page, fakeReader({ enabled: true, code: "1234567" }), {
      waitMs: 1_000,
      intervalMs: 10,
    });
    assert.equal(result, false);
    assert.deepEqual(clicks, []);
    assert.deepEqual(fills, []);
  });

  it("requests the passcode but returns false when no fresh code arrives in time", async () => {
    const { page, clicks, fills } = makeDuoPromptPage({ otherOptions: false, smsFactor: true });
    const result = await attemptDuoSmsPasscode(page, fakeReader({ enabled: true, code: undefined }), {
      waitMs: 0,
      intervalMs: 0,
    });
    assert.equal(result, false);
    assert.deepEqual(clicks, ["smsFactor"]);
    assert.deepEqual(fills, []);
  });

  it("propagates an abort raised during the chat.db wait", async () => {
    const { page } = makeDuoPromptPage({ otherOptions: false, smsFactor: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop requested during Duo")), 25);
    await assert.rejects(
      () =>
        attemptDuoSmsPasscode(page, fakeReader({ enabled: true, code: undefined }), {
          waitMs: 60_000,
          intervalMs: 5_000,
          abortSignal: controller.signal,
        }),
      /stop requested during Duo|aborted/i,
    );
  });
});

describe("pollDuoApproval — SMS passcode integration", () => {
  it("auto-submits the SMS code and skips the manual (voice/Telegram) announce", async () => {
    const { page, clicks, fills, flags } = makeDuoPromptPage({
      otherOptions: false,
      smsFactor: true,
      successUrl: "https://app.example/home",
      pendingUrl: "https://duo.example/prompt",
    });

    const ok = await pollDuoApproval(page, {
      successUrlMatch: "app.example",
      timeoutSeconds: 30,
      preCheckMs: 0,
      initialCodeWaitMs: 0,
      pollIntervalMs: 10,
      smsReader: fakeReader({ enabled: true, code: "1234567" }),
      smsWaitMs: 1_000,
      smsPollIntervalMs: 10,
    });

    assert.equal(ok, true);
    assert.ok(clicks.includes("smsFactor"), "should request the SMS passcode");
    assert.ok(clicks.includes("verify"), "should submit the passcode");
    assert.deepEqual(fills, [{ tag: "input", value: "1234567" }]);
    assert.equal(
      flags.innerTextCalled,
      false,
      "manual-announce code read must be skipped after a successful SMS submit",
    );
  });

  it("falls through to the normal loop when the SMS reader is disabled", async () => {
    const { page, clicks } = makeDuoPromptPage({
      smsFactor: true,
      successUrl: "https://app.example/home",
      pendingUrl: "https://app.example/home", // already at success → loop returns immediately
    });
    const ok = await pollDuoApproval(page, {
      successUrlMatch: "app.example",
      timeoutSeconds: 30,
      preCheckMs: 0,
      initialCodeWaitMs: 0,
      pollIntervalMs: 10,
      smsReader: fakeReader({ enabled: false }),
    });
    assert.equal(ok, true);
    assert.deepEqual(clicks, [], "disabled reader must not interact with the Duo prompt");
  });
});
