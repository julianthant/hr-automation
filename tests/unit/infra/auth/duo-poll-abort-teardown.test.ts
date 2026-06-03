import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

// Partial-mock the WebAuthn module: keep the REAL arm/finish/begin logic
// (so the page-keyed WeakMap, factor selection, and CDP teardown all run for
// real against our fake CDP session), but stub `loadDuoWebAuthnCredentials` so
// the test never touches the gitignored real `.auth/duo-webauthn.json` and runs
// on a fresh clone / CI. A synthetic `internal` credential is enough to arm one
// virtual authenticator.
vi.mock("../../../../src/infra/auth/duo-webauthn.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../../src/infra/auth/duo-webauthn.js")>();
  return {
    ...actual,
    loadDuoWebAuthnCredentials: () => [
      {
        rpId: "duosecurity.com",
        credentialId: "test-credential-id-internal",
        privateKey: "test-fake-private-key-not-real",
        userHandle: "test-user-handle",
        signCount: 7,
        isResidentCredential: false,
        transport: "internal" as const,
        enrolledAt: "2026-06-03",
      },
    ],
  };
});

import { pollDuoApproval } from "../../../../src/infra/auth/duo-poll.js";
import { armDuoWebAuthn } from "../../../../src/infra/auth/duo-webauthn.js";
import { log } from "../../../../src/utils/log.js";

/**
 * Safety pin for the live-pool invariant "never abandon a Duo ceremony mid-flight"
 * — applied to the ABORT path. The daemon stop path and the live multi-system test
 * both cancel auth via `abortSignal`; if `pollDuoApproval` threw the abort without
 * calling `finishDuoWebAuthn`, the armed CDP virtual authenticator would leak and —
 * worse — its advanced signCount would never persist, so Duo would reject the next
 * assertion as a cloned key. This test arms a (fake-CDP-backed) page, aborts a
 * pending poll, and asserts the authenticator was torn down (removeVirtualAuthenticator
 * + WebAuthn.disable + detach) exactly as on a clean timeout/success exit.
 */

interface CdpCall {
  method: string;
  params?: unknown;
}

function makeFakeCdp(): { calls: CdpCall[]; detached: boolean; cdp: import("playwright").CDPSession } {
  const calls: CdpCall[] = [];
  const state = { detached: false };
  const cdp = {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "WebAuthn.addVirtualAuthenticator") {
        return { authenticatorId: "auth-1" };
      }
      if (method === "WebAuthn.getCredentials") {
        // Report the SAME signCount the credential armed with (7), so
        // `hasSigned()` stays false during the factor-selection grace and the
        // ceremony does NOT short-circuit to "auto". This keeps the poll in the
        // factor/manual path where the abort then fires — exercising the
        // abort-teardown path we're pinning (not the happy auto-fire path).
        return { credentials: [{ credentialId: "test-credential-id-internal", signCount: 7 }] };
      }
      return {};
    },
    detach: async () => {
      state.detached = true;
    },
  } as unknown as import("playwright").CDPSession;
  return { calls, get detached() { return state.detached; }, cdp } as never;
}

function makeFakePage(cdp: import("playwright").CDPSession): import("playwright").Page {
  // Locators/getByText/getByRole all resolve to an empty (count 0) chainable so
  // the manual poll loop keeps spinning until the abort fires.
  const empty = {
    count: async () => 0,
    first() { return this; },
    or() { return this; },
    click: async () => {},
    innerText: async () => "UC San Diego\nEnter code in Duo Mobile",
  };
  return {
    url: () => "https://api-prod.duosecurity.com/frame/v4/prompt",
    context: () => ({ newCDPSession: async () => cdp }),
    addInitScript: async () => {},
    evaluate: async () => {},
    locator: () => empty,
    getByRole: () => empty,
    getByText: () => empty,
    // Yield to the MACROTASK queue (real setTimeout), not just a microtask —
    // otherwise the tight factor-selection poll starves the event loop and the
    // abort's setTimeout callback never fires (a real page.waitForTimeout yields
    // to timers too). 1ms keeps the test fast while letting the abort land.
    waitForTimeout: (ms?: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms ?? 1, 1))),
  } as unknown as import("playwright").Page;
}

describe("pollDuoApproval — WebAuthn teardown on abort", () => {
  let prevFlag: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let stepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevFlag = process.env.HR_AUTOMATION_DUO_WEBAUTHN;
    process.env.HR_AUTOMATION_DUO_WEBAUTHN = "1";
    // The arming + fallback paths log via log.step/log.warn legitimately; mute
    // so the stderr audit stays clean while we exercise the abort.
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    stepSpy = vi.spyOn(log, "step").mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.HR_AUTOMATION_DUO_WEBAUTHN;
    else process.env.HR_AUTOMATION_DUO_WEBAUTHN = prevFlag;
    warnSpy.mockRestore();
    stepSpy.mockRestore();
  });

  it("tears down the armed virtual authenticator when the poll is aborted mid-ceremony", async () => {
    const fake = makeFakeCdp();
    const page = makeFakePage(fake.cdp);

    // Arm exactly as clickSsoSubmit does — this registers the page in the
    // module's armedByPage WeakMap and creates the virtual authenticator.
    const armed = await armDuoWebAuthn(page);
    assert.equal(armed, true, "expected the fake-CDP page to arm successfully");
    assert.ok(
      fake.calls.some((c) => c.method === "WebAuthn.addVirtualAuthenticator"),
      "arming should have created a virtual authenticator",
    );

    const controller = new AbortController();
    // Fire the abort shortly after the poll starts spinning. We use a tiny
    // factorTimeout-free manual path: successUrl never matches, so the loop
    // waits on the abort.
    setTimeout(() => controller.abort(new Error("stop requested during Duo")), 30);

    await assert.rejects(
      () =>
        Promise.race([
          pollDuoApproval(page, {
            successUrlMatch: "never-matches",
            timeoutSeconds: 60,
            preCheckMs: 0,
            initialCodeWaitMs: 0,
            pollIntervalMs: 5_000,
            // Keep the WebAuthn grace short so we land in the manual loop fast,
            // where the abort then fires.
            webauthnGraceMs: 20,
            abortSignal: controller.signal,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("poll did not abort")), 1_000),
          ),
        ]),
      /stop requested during Duo|aborted/i,
    );

    // The safety guarantee: abort still finalized WebAuthn — the authenticator
    // was removed and the CDP session detached, and the advanced signCount was
    // read back for persistence. Before the fix, the abort threw straight out
    // of the poll loop and these never ran (leaked authenticator + signCount
    // desync → next Duo assertion rejected as a clone).
    assert.ok(
      fake.calls.some((c) => c.method === "WebAuthn.removeVirtualAuthenticator"),
      "abort path must remove the virtual authenticator",
    );
    assert.ok(
      fake.calls.some((c) => c.method === "WebAuthn.getCredentials"),
      "abort path must read back the signCount before teardown",
    );
    assert.equal(fake.detached, true, "abort path must detach the CDP session");
  });
});
