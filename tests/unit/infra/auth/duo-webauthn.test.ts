import { describe, it, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDuoWebAuthnEnabled,
  parseDuoWebAuthnCredential,
  parseDuoWebAuthnCredentials,
  factorPatternForTransport,
  nextSignCount,
  reserveDuoWebAuthnSignCounts,
  resyncDuoWebAuthnSignCounts,
  acquireDuoWebAuthnLock,
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
