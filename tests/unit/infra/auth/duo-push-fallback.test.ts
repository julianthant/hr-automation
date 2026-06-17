import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { pollDuoApproval } from "../../../../src/infra/auth/duo-poll.js";
import { log } from "../../../../src/utils/log.js";

/**
 * Regression: Duo's Universal Prompt now defaults to a device factor ("Use
 * Touch ID" / "Use your security key") and does NOT auto-send a push, so the
 * poll loop — which only waits for the success URL — would sit out the whole
 * timeout with nothing to approve on the phone (the "stuck on Use Touch ID"
 * hang the operator reported). The loop now auto-clicks "Other options → Duo
 * Push" once, sending a real push the operator can approve.
 *
 * Driven by a stateful fake page (no live Duo): it starts parked on the device
 * prompt with an "Other options" link, reveals a "Duo Push" option when that's
 * clicked, and transitions to the success URL once "Duo Push" is clicked.
 */

const SUCCESS_URL = "https://success.example/landed";
const PROMPT_URL = "https://api-prod.duosecurity.com/frame/v4/prompt";

type Screen = "factor" | "pushPending";

interface FakeState {
  screen: Screen;
  otherClicked: boolean;
  pushClicked: boolean;
  clicks: string[];
}

function targetFor(name: RegExp): "other" | "push" | undefined {
  if (name.test("Duo Push") || name.test("Send me a Push")) return "push";
  if (name.test("Other options") || name.test("Other methods")) return "other";
  return undefined;
}

function makeFakePage(state: FakeState): import("playwright").Page {
  const empty = {
    count: async () => 0,
    first() { return this; },
    or() { return this; },
    click: async () => {},
    innerText: async () => "",
  };

  const available = (target: "other" | "push"): boolean => {
    if (state.screen === "pushPending") return true; // both clickable; the gate must still skip them
    if (target === "other") return !state.otherClicked; // consumed once clicked
    return state.otherClicked && !state.pushClicked; // push appears after revealing options
  };

  const roleMatcher = (name: RegExp) => {
    const target = targetFor(name);
    const self = {
      or() { return self; },
      first() { return self; },
      count: async () => (target && available(target) ? 1 : 0),
      innerText: async () => (target === "push" ? "Duo Push" : target === "other" ? "Other options" : ""),
      click: async () => {
        if (!target || !available(target)) return;
        state.clicks.push(target);
        if (target === "other") state.otherClicked = true;
        if (target === "push") state.pushClicked = true;
      },
    };
    return self;
  };

  const visibleText = (): string => {
    if (state.pushClicked || state.screen === "pushPending") return "Pushed a login request to your device";
    return "Use Touch ID\nVerify your identity using this device";
  };

  const textMatcher = (arg: RegExp | string) => ({
    ...empty,
    count: async () => {
      const hit = typeof arg === "string" ? visibleText().includes(arg) : arg.test(visibleText());
      return hit ? 1 : 0;
    },
  });

  return {
    url: () => (state.pushClicked ? SUCCESS_URL : PROMPT_URL),
    context: () => ({ newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
    addInitScript: async () => {},
    evaluate: async () => {},
    locator: () => empty,
    getByRole: (_role: string, opts?: { name?: RegExp }) => (opts?.name ? roleMatcher(opts.name) : empty),
    getByText: (arg: RegExp | string) => textMatcher(arg),
    waitForTimeout: (ms?: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms ?? 1, 1))),
  } as unknown as import("playwright").Page;
}

describe("pollDuoApproval — auto Duo Push when Duo defaults to a device factor", () => {
  let prevFlag: string | undefined;
  let spies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    prevFlag = process.env.HR_AUTOMATION_DUO_WEBAUTHN;
    delete process.env.HR_AUTOMATION_DUO_WEBAUTHN; // exercise the pure manual loop
    spies = [
      vi.spyOn(log, "warn").mockImplementation(() => {}),
      vi.spyOn(log, "step").mockImplementation(() => {}),
      vi.spyOn(log, "waiting").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.HR_AUTOMATION_DUO_WEBAUTHN;
    else process.env.HR_AUTOMATION_DUO_WEBAUTHN = prevFlag;
    for (const s of spies) s.mockRestore();
  });

  it("clicks Other options → Duo Push, then approves on the resulting success URL", async () => {
    const state: FakeState = { screen: "factor", otherClicked: false, pushClicked: false, clicks: [] };
    const page = makeFakePage(state);

    const approved = await pollDuoApproval(page, {
      successUrlMatch: SUCCESS_URL,
      timeoutSeconds: 5,
      preCheckMs: 0,
      initialCodeWaitMs: 0,
      pollIntervalMs: 1,
    });

    assert.equal(approved, true, "poll should approve once the auto-push lands on the success URL");
    assert.deepEqual(
      state.clicks,
      ["other", "push"],
      "should reveal Other options then click Duo Push, exactly once each",
    );
  });

  it("does not touch the prompt when a push is already pending (normal auto-push prompt)", async () => {
    const state: FakeState = { screen: "pushPending", otherClicked: false, pushClicked: false, clicks: [] };
    const page = makeFakePage(state);

    const approved = await pollDuoApproval(page, {
      successUrlMatch: "never-matches",
      timeoutSeconds: 0.003,
      preCheckMs: 0,
      initialCodeWaitMs: 0,
      pollIntervalMs: 1,
    });

    assert.equal(approved, false, "no success URL → times out");
    assert.deepEqual(state.clicks, [], "must not click Other options / Duo Push when a push is already pending");
  });
});
