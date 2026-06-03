import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseEnrollArgs } from "../../../../src/scripts/ops/duo-webauthn-enroll.js";
import { DUO_WEBAUTHN_CREDENTIAL_PATH } from "../../../../src/infra/auth/duo-webauthn.js";

describe("parseEnrollArgs", () => {
  it("defaults to an internal (Touch ID) authenticator and the .auth path", () => {
    const opts = parseEnrollArgs([]);
    assert.equal(opts.transport, "internal");
    assert.equal(opts.deviceName, "HR Automation (Chrome)");
    assert.equal(opts.out, DUO_WEBAUTHN_CREDENTIAL_PATH);
  });

  it("switches to a usb (Security key) authenticator with --security-key", () => {
    assert.equal(parseEnrollArgs(["--security-key"]).transport, "usb");
  });

  it("takes a custom device label from --name", () => {
    assert.equal(parseEnrollArgs(["--name", "My Bot Key"]).deviceName, "My Bot Key");
  });

  it("takes a custom output path from --out", () => {
    assert.equal(parseEnrollArgs(["--out", "/tmp/cred.json"]).out, "/tmp/cred.json");
  });

  it("ignores a trailing flag with no value", () => {
    const opts = parseEnrollArgs(["--name"]);
    assert.equal(opts.deviceName, "HR Automation (Chrome)");
  });
});
