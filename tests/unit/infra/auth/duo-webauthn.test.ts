import { describe, it, afterAll, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDuoWebAuthnEnabled,
  parseDuoWebAuthnCredential,
  parseDuoWebAuthnCredentials,
  factorPatternForTransport,
  selectDuoFactor,
  nextSignCount,
  reserveDuoWebAuthnSignCounts,
  resyncDuoWebAuthnSignCounts,
  acquireDuoWebAuthnLock,
  armDuoWebAuthn,
  finishDuoWebAuthn,
  loadDuoWebAuthnCredential,
  loadDuoWebAuthnCredentials,
  mergeDuoWebAuthnCredential,
  ctap2SupportShim,
  DUO_WEBAUTHN_CREDENTIAL_PATH,
  DUO_WEBAUTHN_SIGNCOUNT_RESERVE,
  DUO_WEBAUTHN_SIGNCOUNT_RESYNC,
  type DuoWebAuthnCredential,
} from "../../../../src/infra/auth/duo-webauthn.js";
import { log } from "../../../../src/utils/log.js";

// All fixture identifiers below are SYNTHETIC placeholders — not real Duo
// credentials. The parser only checks that these fields are non-empty strings
// (no base64/DER decoding), so opaque test tokens exercise every path. Do not
// paste values from `.auth/duo-webauthn.json` here; that file holds real keys.
const VALID: DuoWebAuthnCredential = {
  rpId: "duosecurity.com",
  credentialId: "test-credential-id-internal",
  privateKey: "test-fake-private-key-not-real",
  userHandle: "test-user-handle",
  signCount: 3,
  isResidentCredential: false,
  transport: "internal",
  enrolledAt: "2026-06-02",
};
const USB: DuoWebAuthnCredential = { ...VALID, transport: "usb", credentialId: "test-credential-id-usb" };

const tmp = mkdtempSync(join(tmpdir(), "duo-webauthn-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("isDuoWebAuthnEnabled", () => {
  it("is true only when the flag is exactly '1'", () => {
    assert.equal(isDuoWebAuthnEnabled({ HR_AUTOMATION_DUO_WEBAUTHN: "1" }), true);
  });

  it("is false for unset, empty, or any other value", () => {
    assert.equal(isDuoWebAuthnEnabled({}), false);
    assert.equal(isDuoWebAuthnEnabled({ HR_AUTOMATION_DUO_WEBAUTHN: "" }), false);
    assert.equal(isDuoWebAuthnEnabled({ HR_AUTOMATION_DUO_WEBAUTHN: "0" }), false);
    assert.equal(isDuoWebAuthnEnabled({ HR_AUTOMATION_DUO_WEBAUTHN: "true" }), false);
    assert.equal(isDuoWebAuthnEnabled({ HR_AUTOMATION_DUO_WEBAUTHN: "yes" }), false);
  });
});

describe("parseDuoWebAuthnCredential", () => {
  it("parses a fully-populated valid credential", () => {
    assert.deepEqual(parseDuoWebAuthnCredential({ ...VALID }), VALID);
  });

  it("accepts the usb transport", () => {
    const cred = parseDuoWebAuthnCredential({ ...VALID, transport: "usb" });
    assert.equal(cred?.transport, "usb");
  });

  it("returns undefined for non-objects", () => {
    assert.equal(parseDuoWebAuthnCredential(null), undefined);
    assert.equal(parseDuoWebAuthnCredential("nope"), undefined);
    assert.equal(parseDuoWebAuthnCredential(42), undefined);
    assert.equal(parseDuoWebAuthnCredential(undefined), undefined);
  });

  it("requires rpId, credentialId, and privateKey", () => {
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, rpId: "" }), undefined);
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, credentialId: undefined }), undefined);
    const { privateKey: _omit, ...noKey } = VALID;
    assert.equal(parseDuoWebAuthnCredential(noKey), undefined);
  });

  it("requires a finite numeric signCount", () => {
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, signCount: "3" }), undefined);
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, signCount: Number.NaN }), undefined);
  });

  it("rejects an unknown transport", () => {
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, transport: "nfc" }), undefined);
    assert.equal(parseDuoWebAuthnCredential({ ...VALID, transport: undefined }), undefined);
  });

  it("omits an absent userHandle and coerces isResidentCredential to a boolean", () => {
    const { userHandle: _omit, ...noHandle } = VALID;
    const cred = parseDuoWebAuthnCredential({ ...noHandle, isResidentCredential: "yes" });
    assert.equal(cred?.userHandle, undefined);
    assert.equal(cred?.isResidentCredential, false);
  });
});

describe("factorPatternForTransport", () => {
  it("maps internal → the Touch ID factor", () => {
    const re = factorPatternForTransport("internal");
    assert.equal(re.test("Touch ID"), true);
    assert.equal(re.test("Use Touch ID on this device"), true);
    assert.equal(re.test("Security key"), false);
  });

  it("maps usb → the Security key factor", () => {
    const re = factorPatternForTransport("usb");
    assert.equal(re.test("Security key"), true);
    assert.equal(re.test("Use a hardware security key"), true);
    assert.equal(re.test("Touch ID"), false);
  });
});

describe("nextSignCount", () => {
  it("advances to the larger of saved and observed", () => {
    assert.equal(nextSignCount(1, 3), 3);
    assert.equal(nextSignCount(5, 2), 5);
  });

  it("falls back to saved when observed is undefined", () => {
    assert.equal(nextSignCount(7, undefined), 7);
  });

  it("never returns below zero", () => {
    assert.equal(nextSignCount(-4, undefined), 0);
  });
});

describe("reserveDuoWebAuthnSignCounts", () => {
  it("persists a counter window without mutating the CDP seed credentials", () => {
    const p = join(tmp, "reserve.json");
    const internal: DuoWebAuthnCredential = { ...VALID, signCount: 3 };
    const usb: DuoWebAuthnCredential = { ...USB, signCount: 8 };
    writeFileSync(p, JSON.stringify({ credentials: [internal, usb] }));

    assert.equal(reserveDuoWebAuthnSignCounts([internal, usb], p), true);

    const saved = loadDuoWebAuthnCredentials(p);
    assert.equal(saved.find((c) => c.transport === "internal")?.signCount, 3 + DUO_WEBAUTHN_SIGNCOUNT_RESERVE);
    assert.equal(saved.find((c) => c.transport === "usb")?.signCount, 8 + DUO_WEBAUTHN_SIGNCOUNT_RESERVE);
    assert.equal(internal.signCount, 3);
    assert.equal(usb.signCount, 8);
  });

  it("returns false when the file does not contain the target credential", () => {
    const p = join(tmp, "reserve-missing.json");
    writeFileSync(p, JSON.stringify({ credentials: [USB] }));

    assert.equal(reserveDuoWebAuthnSignCounts([VALID], p), false);
  });
});

describe("resyncDuoWebAuthnSignCounts", () => {
  it("jumps every enrolled credential forward by the resync margin", () => {
    const p = join(tmp, "resync.json");
    writeFileSync(
      p,
      JSON.stringify({ credentials: [{ ...VALID, signCount: 5 }, { ...USB, signCount: 9 }] }),
    );

    assert.equal(resyncDuoWebAuthnSignCounts(p), true);

    const saved = loadDuoWebAuthnCredentials(p);
    assert.equal(saved.find((c) => c.transport === "internal")?.signCount, 5 + DUO_WEBAUTHN_SIGNCOUNT_RESYNC);
    assert.equal(saved.find((c) => c.transport === "usb")?.signCount, 9 + DUO_WEBAUTHN_SIGNCOUNT_RESYNC);
  });

  it("accepts a custom margin", () => {
    const p = join(tmp, "resync-custom.json");
    writeFileSync(p, JSON.stringify({ credentials: [{ ...VALID, signCount: 1 }] }));

    assert.equal(resyncDuoWebAuthnSignCounts(p, 42), true);
    assert.equal(loadDuoWebAuthnCredentials(p)[0]?.signCount, 1 + 42);
  });

  it("is a larger jump than the per-arm reserve so one retry clears a multi-step drift", () => {
    assert.ok(DUO_WEBAUTHN_SIGNCOUNT_RESYNC > DUO_WEBAUTHN_SIGNCOUNT_RESERVE);
  });

  it("returns false (no-op) when the credential file is absent", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      assert.equal(resyncDuoWebAuthnSignCounts(join(tmp, "does-not-exist.json")), false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("acquireDuoWebAuthnLock", () => {
  it("serializes contenders until the current holder releases", async () => {
    const lockDir = join(tmp, "duo-lock");
    const first = await acquireDuoWebAuthnLock({ lockDir, staleMs: 10_000, pollMs: 5 });
    let secondResolved = false;

    const secondPromise = acquireDuoWebAuthnLock({ lockDir, staleMs: 10_000, pollMs: 5 }).then((lock) => {
      secondResolved = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondResolved, false);

    first.release();
    const second = await Promise.race([
      secondPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second lock did not acquire")), 1_000)),
    ]);
    assert.equal(secondResolved, true);
    second.release();
  });
});

describe("loadDuoWebAuthnCredential", () => {
  it("defaults to the gitignored .auth path", () => {
    assert.equal(DUO_WEBAUTHN_CREDENTIAL_PATH, ".auth/duo-webauthn.json");
  });

  it("reads and validates a credential file", () => {
    const p = join(tmp, "valid.json");
    writeFileSync(p, JSON.stringify(VALID));
    assert.deepEqual(loadDuoWebAuthnCredential(p), VALID);
  });

  it("returns undefined (no throw) when the file is missing", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      assert.equal(loadDuoWebAuthnCredential(join(tmp, "nope.json")), undefined);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns undefined for invalid JSON", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{ not json");
    try {
      assert.equal(loadDuoWebAuthnCredential(p), undefined);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns undefined for a structurally-invalid credential", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const p = join(tmp, "shape.json");
    writeFileSync(p, JSON.stringify({ rpId: "duosecurity.com" }));
    try {
      assert.equal(loadDuoWebAuthnCredential(p), undefined);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the first credential of a multi-credential file", () => {
    const p = join(tmp, "multi-first.json");
    const usb: DuoWebAuthnCredential = { ...VALID, transport: "usb", credentialId: "test-credential-id-usb" };
    writeFileSync(p, JSON.stringify({ credentials: [VALID, usb] }));
    assert.deepEqual(loadDuoWebAuthnCredential(p), VALID);
  });
});

describe("parseDuoWebAuthnCredentials", () => {
  it("parses the { credentials: [...] } multi-credential shape in order", () => {
    const out = parseDuoWebAuthnCredentials({ credentials: [VALID, USB] });
    assert.equal(out.length, 2);
    assert.equal(out[0]?.transport, "internal");
    assert.equal(out[1]?.transport, "usb");
  });

  it("accepts a legacy single top-level credential object", () => {
    assert.deepEqual(parseDuoWebAuthnCredentials({ ...VALID }), [VALID]);
  });

  it("drops structurally-invalid entries but keeps the valid ones", () => {
    const out = parseDuoWebAuthnCredentials({ credentials: [VALID, { rpId: "x" }, 42, null] });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.credentialId, VALID.credentialId);
  });

  it("returns an empty array for non-objects or an empty list", () => {
    assert.deepEqual(parseDuoWebAuthnCredentials(null), []);
    assert.deepEqual(parseDuoWebAuthnCredentials("nope"), []);
    assert.deepEqual(parseDuoWebAuthnCredentials({ credentials: [] }), []);
  });
});

describe("loadDuoWebAuthnCredentials", () => {
  it("reads every credential from a multi-credential file", () => {
    const p = join(tmp, "multi.json");
    writeFileSync(p, JSON.stringify({ credentials: [VALID, USB] }));
    const out = loadDuoWebAuthnCredentials(p);
    assert.equal(out.length, 2);
    assert.equal(out[1]?.transport, "usb");
  });

  it("returns an empty array (no throw) when the file is missing", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      assert.deepEqual(loadDuoWebAuthnCredentials(join(tmp, "nope-multi.json")), []);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("mergeDuoWebAuthnCredential", () => {
  it("appends a credential with a new transport, preserving the other", () => {
    assert.deepEqual(mergeDuoWebAuthnCredential([VALID], USB), [VALID, USB]);
  });

  it("replaces the existing credential of the same transport", () => {
    const rotated: DuoWebAuthnCredential = { ...VALID, credentialId: "NEWID==", signCount: 0 };
    assert.deepEqual(mergeDuoWebAuthnCredential([VALID], rotated), [rotated]);
  });

  it("replaces a credential sharing the same credentialId across transports", () => {
    const sameId: DuoWebAuthnCredential = { ...VALID, transport: "usb" };
    assert.deepEqual(mergeDuoWebAuthnCredential([VALID], sameId), [sameId]);
  });

  it("starts a fresh set from an empty list", () => {
    assert.deepEqual(mergeDuoWebAuthnCredential([], VALID), [VALID]);
  });
});

describe("ctap2SupportShim", () => {
  it("forces isExternalCTAP2SecurityKeySupported to resolve true on the page global", async () => {
    const g = globalThis as unknown as { PublicKeyCredential?: Record<string, unknown> };
    const had = "PublicKeyCredential" in g;
    const prev = g.PublicKeyCredential;
    g.PublicKeyCredential = {};
    try {
      ctap2SupportShim();
      const fn = g.PublicKeyCredential.isExternalCTAP2SecurityKeySupported as () => Promise<boolean>;
      assert.equal(typeof fn, "function");
      assert.equal(await fn(), true);
    } finally {
      if (had) g.PublicKeyCredential = prev;
      else delete g.PublicKeyCredential;
    }
  });

  it("does not throw when PublicKeyCredential is absent", () => {
    const g = globalThis as unknown as { PublicKeyCredential?: unknown };
    const had = "PublicKeyCredential" in g;
    const prev = g.PublicKeyCredential;
    delete g.PublicKeyCredential;
    try {
      assert.doesNotThrow(() => ctap2SupportShim());
    } finally {
      if (had) g.PublicKeyCredential = prev;
    }
  });
});

describe("armDuoWebAuthn (stale-CDP re-arm)", () => {
  // A minimal in-memory CDP stub. `WebAuthn.enable` is the probe the re-arm
  // guard uses; flip `staleAfterArm` to make a previously-armed session's probe
  // throw (simulating a page reload that destroyed the CDP target).
  interface FakeCdp {
    id: number;
    enableThrows: boolean;
    detached: boolean;
    send: (method: string, params?: unknown) => Promise<unknown>;
    detach: () => Promise<void>;
  }

  const makeArmEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "duo-arm-"));
    const credPath = join(dir, "creds.json");
    const lockDir = join(dir, "lock");
    writeFileSync(credPath, JSON.stringify({ credentials: [{ ...VALID, signCount: 1 }] }));
    const prevCred = process.env.HR_AUTOMATION_DUO_WEBAUTHN_CREDENTIAL_PATH;
    const prevLock = process.env.HR_AUTOMATION_DUO_WEBAUTHN_LOCK_DIR;
    process.env.HR_AUTOMATION_DUO_WEBAUTHN_CREDENTIAL_PATH = credPath;
    process.env.HR_AUTOMATION_DUO_WEBAUTHN_LOCK_DIR = lockDir;
    return {
      dir,
      restore: () => {
        if (prevCred === undefined) delete process.env.HR_AUTOMATION_DUO_WEBAUTHN_CREDENTIAL_PATH;
        else process.env.HR_AUTOMATION_DUO_WEBAUTHN_CREDENTIAL_PATH = prevCred;
        if (prevLock === undefined) delete process.env.HR_AUTOMATION_DUO_WEBAUTHN_LOCK_DIR;
        else process.env.HR_AUTOMATION_DUO_WEBAUTHN_LOCK_DIR = prevLock;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  // Each newCDPSession() hands out a fresh fake CDP; `cdps` keeps them so the
  // test can flip the FIRST one stale before the second arm.
  const makePage = (cdps: FakeCdp[]) => {
    let nextId = 0;
    const newCDPSession = async (): Promise<FakeCdp> => {
      const cdp: FakeCdp = {
        id: nextId++,
        enableThrows: false,
        detached: false,
        send: async (method: string) => {
          if (method === "WebAuthn.enable" && cdp.enableThrows) {
            throw new Error("Target closed (page reloaded)");
          }
          if (method === "WebAuthn.addVirtualAuthenticator") {
            return { authenticatorId: `auth-${cdp.id}` };
          }
          // enable / disable / addCredential / getCredentials / remove → ok
          return {};
        },
        detach: async () => {
          cdp.detached = true;
        },
      };
      cdps.push(cdp);
      return cdp;
    };
    const page = {
      addInitScript: async () => {},
      evaluate: async () => {},
      context: () => ({ newCDPSession }),
    } as unknown as import("playwright").Page;
    return page;
  };

  it("reuses the cached arm when the CDP probe succeeds", async () => {
    const env = makeArmEnv();
    const cdps: FakeCdp[] = [];
    const page = makePage(cdps);
    try {
      assert.equal(await armDuoWebAuthn(page), true);
      assert.equal(cdps.length, 1, "first arm creates one CDP session");
      // Second arm: probe succeeds → no new CDP session, no detach.
      assert.equal(await armDuoWebAuthn(page), true);
      assert.equal(cdps.length, 1, "probe-OK path must NOT create a second CDP session");
      assert.equal(cdps[0].detached, false);
    } finally {
      await finishDuoWebAuthn(page);
      env.restore();
    }
  });

  it("re-arms fresh when the cached CDP probe fails (stale target after a reload)", async () => {
    const env = makeArmEnv();
    const cdps: FakeCdp[] = [];
    const page = makePage(cdps);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      assert.equal(await armDuoWebAuthn(page), true);
      assert.equal(cdps.length, 1);

      // Simulate the page being reloaded out from under the cached authenticator:
      // the stored CDP target is now dead, so its WebAuthn.enable probe throws.
      cdps[0].enableThrows = true;

      assert.equal(await armDuoWebAuthn(page), true, "must self-heal to armed");
      assert.equal(cdps.length, 2, "stale probe must trigger a FRESH CDP session");
      assert.equal(cdps[0].detached, true, "stale CDP session is detached");
      assert.ok(
        warn.mock.calls.some((c) => String(c[0]).includes("stale")),
        "logs a stale-authenticator warning",
      );
    } finally {
      await finishDuoWebAuthn(page);
      warn.mockRestore();
      env.restore();
    }
  });
});

describe("selectDuoFactor — ISS-005 pre-prompt guard", () => {
  // Regression pin for the first-attempt "Duo WebAuthn factor not found" flake
  // (commit d250edb9): the factor-detection deadline could elapse while the page
  // was STILL mid SSO→Duo transition (no Duo prompt rendered yet). The old code
  // mis-read that as "no factor" and fell back to a dead ~180s manual wait. The
  // fix keeps waiting past the factor deadline (up to an absolute
  // `promptRenderCap`) WHILE no Duo screen is visible, and only gives up once the
  // prompt is genuinely up with no matching factor. A live Duo soak cannot force
  // a slow render (CRM's auto-fire signs before the deadline matters), so the
  // guard's recovery-on-slow-render is pinned deterministically here.
  //
  // Determinism comes from an INJECTED virtual clock: `now()` reads a mutable
  // counter that the fake page's `waitForTimeout(ms)` advances by `ms`, so time
  // only moves at each ~600ms poll-loop sleep — no real waiting, no wall clock.

  // These mirror the shipped code defaults (`selectDuoFactor` reads
  // DUO_FACTOR_PROMPT_RENDER_GRACE_MS = 25_000 internally; the factor window is
  // the `timeoutMs` argument). promptRenderCap = max(timeoutMs, 20_000) + grace.
  const FACTOR_WINDOW_MS = 1_000;
  const PROMPT_RENDER_GRACE_MS = 25_000;
  const EXPECTED_CAP_FROM_START = Math.max(FACTOR_WINDOW_MS, 20_000) + PROMPT_RENDER_GRACE_MS; // 45_000
  const CLOCK_BASE = 1_000_000;

  const factorOrder = [factorPatternForTransport("internal"), factorPatternForTransport("usb")];

  const matches = (candidate: string, name: RegExp | string): boolean =>
    typeof name === "string" ? candidate.includes(name) : name.test(candidate);

  // A minimal fake Playwright Page whose visible screen is a function of virtual
  // time. `presentTexts`/`presentLinks` return what the DOM would show at clock
  // `t` — letting a test model "SSO page now, Duo prompt after N virtual ms".
  const makeFakePage = (opts: {
    clock: { t: number };
    presentTexts: (t: number) => string[];
    presentLinks: (t: number) => string[];
    clicks: string[];
  }): import("playwright").Page => {
    const { clock, presentTexts, presentLinks, clicks } = opts;

    const labelLocator = (labels: string[]) => {
      const self = {
        or: () => self, // combined link|button — our scenarios never present these targets
        first: () => self,
        all: async () => labels.map((label) => ({ innerText: async () => label })),
        count: async () => labels.length,
        innerText: async () => labels[0] ?? "",
        click: async () => {
          if (labels[0]) clicks.push(labels[0]);
        },
      };
      return self;
    };

    return {
      url: () => "https://a5.ucsd.edu/tritON/profile/SAML2/Redirect/SSO?execution=e1s3",
      keyboard: { press: async () => {} },
      waitForTimeout: async (ms?: number) => {
        clock.t += ms ?? 0;
      },
      getByText: (arg: RegExp | string) => ({
        first() {
          return this;
        },
        innerText: async () => "",
        count: async () => presentTexts(clock.t).filter((tx) => matches(tx, arg)).length,
      }),
      getByRole: (role: string, o?: { name?: RegExp }) => {
        const pool = role === "link" ? presentLinks(clock.t) : [];
        const filtered = o?.name ? pool.filter((l) => o.name!.test(l)) : pool;
        return labelLocator(filtered);
      },
    } as unknown as import("playwright").Page;
  };

  const guardExtended = (step: ReturnType<typeof vi.spyOn>): boolean =>
    step.mock.calls.some((c: unknown[]) => String(c[0]).includes("prompt not rendered within the factor window"));

  let step: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    step = vi.spyOn(log, "step").mockImplementation(() => {});
    warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    step.mockRestore();
    warn.mockRestore();
  });

  it("(a) recovers when the deadline elapses PRE-PROMPT and the factor renders after it", async () => {
    // No Duo screen until virtual t = base+3_000 — well past the base+1_000 factor
    // deadline — then the preferred Touch ID factor appears.
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const renderAt = CLOCK_BASE + 3_000;
    const page = makeFakePage({
      clock,
      clicks,
      presentTexts: () => [],
      presentLinks: (t) => (t >= renderAt ? ["Touch ID"] : []),
    });

    const label = await selectDuoFactor(page, factorOrder, FACTOR_WINDOW_MS, undefined, undefined, () => clock.t);

    assert.equal(label, "Touch ID", "must return the factor that rendered AFTER the initial deadline, not undefined");
    assert.deepEqual(clicks, ["Touch ID"], "clicks the recovered preferred factor exactly once");
    assert.equal(guardExtended(step), true, "the ISS-005 guard must extend past the factor deadline while pre-prompt");
    assert.ok(clock.t >= renderAt, "kept polling until the prompt actually rendered");
  });

  it("(b) gives up (undefined) WITHOUT extending when a Duo screen is up but no factor matches", async () => {
    // A Duo screen IS rendered the whole time (the "Use Touch ID" instruction is
    // visible) but there is no clickable factor link that matches our transports.
    // The guard must NOT extend — this is the real give-up.
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const page = makeFakePage({
      clock,
      clicks,
      presentTexts: () => ["Use Touch ID"],
      presentLinks: () => [],
    });

    const label = await selectDuoFactor(page, factorOrder, FACTOR_WINDOW_MS, undefined, undefined, () => clock.t);

    assert.equal(label, undefined, "prompt is up with no matching factor → genuine give-up");
    assert.deepEqual(clicks, [], "no factor to click");
    assert.equal(guardExtended(step), false, "guard must NOT extend when the Duo prompt has already rendered");
    assert.ok(
      clock.t < CLOCK_BASE + EXPECTED_CAP_FROM_START,
      "gave up at the factor deadline, nowhere near the render cap",
    );
  });

  it("(c) waits to promptRenderCap then gives up (undefined) when the prompt NEVER renders", async () => {
    // Pre-prompt forever: no Duo screen ever appears. The guard extends until the
    // absolute cap (factor window + grace), then gives up — bounded, not infinite.
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const page = makeFakePage({
      clock,
      clicks,
      presentTexts: () => [],
      presentLinks: () => [],
    });

    const label = await selectDuoFactor(page, factorOrder, FACTOR_WINDOW_MS, undefined, undefined, () => clock.t);

    assert.equal(label, undefined, "never-rendered prompt still ends in a give-up");
    assert.equal(guardExtended(step), true, "guard extended past the initial deadline");
    assert.ok(
      clock.t >= CLOCK_BASE + EXPECTED_CAP_FROM_START,
      "waited to the absolute promptRenderCap (factor window + render grace) before giving up",
    );
  });

  // ── Strengthening edge cases (the (a)/(b)/(c) trio above already pins the
  // core regression: the deadline must not elapse — i.e. must not be read as
  // "no factor" — while the page is still pre-prompt. These two cases probe
  // the boundary of that guard rather than duplicate it. ──

  it("(d) propagates an abort fired DURING the pre-prompt extension instead of silently resolving to undefined (fail loud)", async () => {
    // A cancellation (e.g. daemon stop, run cancel) that lands while the ISS-005
    // guard is extending past the initial factor deadline — but still well before
    // the render cap — must interrupt the wait immediately, not be swallowed by
    // the extension loop and reported as an ordinary "factor not found" give-up.
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const controller = new AbortController();
    const abortAt = CLOCK_BASE + 1_800; // a few polls into the extended (post-deadline) window
    const abortError = new Error("cancelled: daemon stop");
    const page = makeFakePage({
      clock,
      clicks,
      presentTexts: () => [],
      presentLinks: () => [], // prompt never renders — same shape as scenario (c)
    });
    // Piggyback on waitForTimeout (the only place virtual time advances) to
    // fire the abort once the clock crosses the threshold.
    const originalWaitForTimeout = page.waitForTimeout.bind(page);
    (page as unknown as { waitForTimeout: (ms?: number) => Promise<void> }).waitForTimeout = async (ms?: number) => {
      await originalWaitForTimeout(ms ?? 0);
      if (!controller.signal.aborted && clock.t >= abortAt) controller.abort(abortError);
    };

    await assert.rejects(
      () => selectDuoFactor(page, factorOrder, FACTOR_WINDOW_MS, controller.signal, undefined, () => clock.t),
      (err: unknown) => err === abortError,
      "must reject with the abort reason, not resolve to undefined",
    );
    assert.deepEqual(clicks, [], "never reaches a factor click");
    assert.ok(
      clock.t < CLOCK_BASE + EXPECTED_CAP_FROM_START,
      "aborted well before the render cap — the extension does not swallow cancellation",
    );
  });

  it("(e) a factor window larger than the 20s floor scales the render cap accordingly (promptRenderCap = timeoutMs + grace)", async () => {
    // promptRenderCap = max(timeoutMs, 20_000) + DUO_FACTOR_PROMPT_RENDER_GRACE_MS.
    // (a)/(b)/(c) all use a sub-20s window, exercising only the 20s floor. This
    // pins the OTHER branch of the max() — a caller-supplied window bigger than
    // the floor must extend the cap past 45s, not clamp back down to it.
    const LARGE_FACTOR_WINDOW_MS = 30_000;
    const EXPECTED_LARGE_CAP = LARGE_FACTOR_WINDOW_MS + PROMPT_RENDER_GRACE_MS; // 55_000
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const page = makeFakePage({
      clock,
      clicks,
      presentTexts: () => [],
      presentLinks: () => [],
    });

    const label = await selectDuoFactor(page, factorOrder, LARGE_FACTOR_WINDOW_MS, undefined, undefined, () => clock.t);

    assert.equal(label, undefined, "never-rendered prompt still ends in a give-up");
    assert.ok(
      clock.t >= CLOCK_BASE + EXPECTED_LARGE_CAP,
      `expected to wait to the scaled cap (${EXPECTED_LARGE_CAP}ms), only waited ${clock.t - CLOCK_BASE}ms`,
    );
    assert.ok(
      clock.t < CLOCK_BASE + EXPECTED_LARGE_CAP + 5_000,
      "must not wait dramatically past the scaled cap either (still bounded)",
    );
  });
});

describe("selectDuoFactor — Phase 1 security-key auto-fire (no early bail)", () => {
  // Regression pin for the removed Phase-1 early break: the old code bailed
  // straight to the Phase-2 click path (Escape → "Other options" → factor) the
  // instant the security-key screen text appeared, assuming CRM's roaming-key
  // native dialog could never self-answer. The shipped behavior instead stays in
  // the Phase-1 grace loop — the pre-armed `usb` virtual authenticator CAN answer
  // an auto-fired security-key ceremony hands-off — and returns "auto" the moment
  // `hasSigned` flips. Same virtual-clock fake-page pattern as the ISS-005 block:
  // `waitForTimeout(ms)` advances the injected clock, so no real waiting.
  const FACTOR_WINDOW_MS = 20_000;
  const PHASE1_GRACE_MS = 12_000; // Phase-1 grace window: min(deadline, now + 12_000)
  const CLOCK_BASE = 2_000_000;

  const factorOrder = [factorPatternForTransport("internal"), factorPatternForTransport("usb")];

  const matches = (candidate: string, name: RegExp | string): boolean =>
    typeof name === "string" ? candidate.includes(name) : name.test(candidate);

  // Minimal fake page on the Duo prompt showing the security-key screen the
  // whole time. Records every factor/option click AND every keyboard press —
  // the old early-bail path pressed Escape and clicked "Other options", so an
  // empty recording proves Phase 1 never handed off to the click path.
  const makeSecurityKeyPromptPage = (opts: {
    clock: { t: number };
    clicks: string[];
    keyPresses: string[];
  }): import("playwright").Page => {
    const { clock, clicks, keyPresses } = opts;
    const presentTexts = ["Use your security key"];
    const presentLinks = ["Other options"];

    const labelLocator = (labels: string[]) => {
      const self = {
        or: () => self,
        first: () => self,
        all: async () => labels.map((label) => ({ innerText: async () => label })),
        count: async () => labels.length,
        innerText: async () => labels[0] ?? "",
        click: async () => {
          if (labels[0]) clicks.push(labels[0]);
        },
      };
      return self;
    };

    return {
      url: () => "https://api-0000.duosecurity.com/frame/v4/auth/prompt",
      keyboard: {
        press: async (key: string) => {
          keyPresses.push(key);
        },
      },
      waitForTimeout: async (ms?: number) => {
        clock.t += ms ?? 0;
      },
      getByText: (arg: RegExp | string) => ({
        first() {
          return this;
        },
        innerText: async () => "",
        count: async () => presentTexts.filter((tx) => matches(tx, arg)).length,
      }),
      getByRole: (role: string, o?: { name?: RegExp }) => {
        const pool = role === "link" ? presentLinks : [];
        const filtered = o?.name ? pool.filter((l) => o.name!.test(l)) : pool;
        return labelLocator(filtered);
      },
    } as unknown as import("playwright").Page;
  };

  it("waits out the auto-fired ceremony on the security-key screen and returns 'auto' once hasSigned flips", async () => {
    const clock = { t: CLOCK_BASE };
    const clicks: string[] = [];
    const keyPresses: string[] = [];
    const page = makeSecurityKeyPromptPage({ clock, clicks, keyPresses });

    // The pre-armed authenticator signs the auto-fired ceremony a few poll
    // iterations in — well AFTER the point where the old code would already
    // have bailed to the click path (it broke on the very first sighting of
    // the security-key screen text).
    const signedAt = CLOCK_BASE + 2_000;
    const hasSigned = async (): Promise<boolean> => clock.t >= signedAt;

    const step = vi.spyOn(log, "step").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const label = await selectDuoFactor(page, factorOrder, FACTOR_WINDOW_MS, undefined, hasSigned, () => clock.t);

      assert.equal(label, "auto", "must report the hands-off auto-fire result once the authenticator signs");
      assert.deepEqual(clicks, [], "no early bail: never clicks 'Other options' or a factor mid-ceremony");
      assert.deepEqual(keyPresses, [], "no early bail: never presses Escape to dismiss the security-key dialog");
      assert.ok(clock.t >= signedAt, "polled until the signature landed");
      assert.ok(
        clock.t < CLOCK_BASE + PHASE1_GRACE_MS,
        "returned inside the Phase-1 grace window — never fell through to Phase 2",
      );
    } finally {
      step.mockRestore();
      warn.mockRestore();
    }
  });
});
