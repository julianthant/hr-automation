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
  loadDuoWebAuthnCredential,
  loadDuoWebAuthnCredentials,
  mergeDuoWebAuthnCredential,
  ctap2SupportShim,
  DUO_WEBAUTHN_CREDENTIAL_PATH,
  type DuoWebAuthnCredential,
} from "../../../../src/infra/auth/duo-webauthn.js";
import { log } from "../../../../src/utils/log.js";

const VALID: DuoWebAuthnCredential = {
  rpId: "duosecurity.com",
  credentialId: "rZrKrwIX8nXY==",
  privateKey: "MIGHAgEAMBMGByqGSM49==",
  userHandle: "DUHMZISRN04XM2QNEQNO",
  signCount: 3,
  isResidentCredential: false,
  transport: "internal",
  enrolledAt: "2026-06-02",
};

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
    const usb: DuoWebAuthnCredential = { ...VALID, transport: "usb", credentialId: "qhNNTCW==" };
    writeFileSync(p, JSON.stringify({ credentials: [VALID, usb] }));
    assert.deepEqual(loadDuoWebAuthnCredential(p), VALID);
  });
});

const USB: DuoWebAuthnCredential = { ...VALID, transport: "usb", credentialId: "qhNNTCW==" };

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
