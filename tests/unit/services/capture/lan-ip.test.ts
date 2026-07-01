import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyLanIp,
  isPhoneUnreachableLanIp,
  pickLanIpFrom,
} from "../../../../src/services/capture/lan-ip.js";
import type { NetworkInterfaceInfo } from "node:os";

function iface(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "aa:bb:cc:dd:ee:ff",
    internal: false,
    cidr: `${address}/24`,
  };
}

const lo: NetworkInterfaceInfo = {
  address: "127.0.0.1",
  netmask: "255.0.0.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal: true,
  cidr: "127.0.0.1/8",
};
const en0: NetworkInterfaceInfo = {
  address: "192.168.1.50",
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "aa:bb:cc:dd:ee:ff",
  internal: false,
  cidr: "192.168.1.50/24",
};
const en1: NetworkInterfaceInfo = {
  address: "10.0.0.5",
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "11:22:33:44:55:66",
  internal: false,
  cidr: "10.0.0.5/24",
};
const v6: NetworkInterfaceInfo = {
  address: "fe80::1",
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: "fe80::1/64",
  scopeid: 0,
};

describe("pickLanIpFrom", () => {
  it("returns the first non-internal IPv4", () => {
    assert.equal(pickLanIpFrom({ lo: [lo], en0: [en0] }), "192.168.1.50");
  });

  it("skips loopback / internal interfaces", () => {
    assert.equal(pickLanIpFrom({ lo: [lo] }), undefined);
  });

  it("skips IPv6", () => {
    assert.equal(pickLanIpFrom({ en0: [v6] }), undefined);
  });

  it("returns undefined for empty input", () => {
    assert.equal(pickLanIpFrom({}), undefined);
  });

  it("returns first eligible when multiple candidates exist", () => {
    assert.equal(pickLanIpFrom({ en0: [en0], en1: [en1] }), "192.168.1.50");
  });

  it("handles undefined entries (Node sometimes returns undefined arrays)", () => {
    assert.equal(pickLanIpFrom({ en0: undefined, en1: [en1] }), "10.0.0.5");
  });

  it("prefers a private RFC1918 address over a CGNAT one enumerated first", () => {
    // Real-world shape: a CGNAT WiFi lease (or Tailscale-ish iface) shows up
    // before the true private LAN. The private one must still win.
    assert.equal(
      pickLanIpFrom({ en0: [iface("100.64.71.114")], en1: [iface("192.168.1.50")] }),
      "192.168.1.50",
    );
  });

  it("falls back to the first eligible address when none are private (CGNAT-only)", () => {
    // The machine that triggered this fix: en0 has ONLY a CGNAT address, so the
    // QR still carries a URL — the caller warns it may be unreachable.
    assert.equal(pickLanIpFrom({ en0: [iface("100.64.71.114")] }), "100.64.71.114");
  });
});

describe("classifyLanIp", () => {
  it("classifies RFC1918 private ranges", () => {
    assert.equal(classifyLanIp("10.0.0.5"), "private");
    assert.equal(classifyLanIp("172.16.4.4"), "private");
    assert.equal(classifyLanIp("172.31.255.1"), "private");
    assert.equal(classifyLanIp("192.168.1.50"), "private");
  });

  it("classifies CGNAT (100.64.0.0/10)", () => {
    assert.equal(classifyLanIp("100.64.71.114"), "cgnat");
    assert.equal(classifyLanIp("100.64.0.0"), "cgnat");
    assert.equal(classifyLanIp("100.127.255.255"), "cgnat");
  });

  it("does NOT treat non-CGNAT 100.x as CGNAT", () => {
    assert.equal(classifyLanIp("100.63.0.1"), "other"); // below the /10
    assert.equal(classifyLanIp("100.128.0.1"), "other"); // above the /10
  });

  it("classifies link-local, loopback, and a 172.x that is outside /12", () => {
    assert.equal(classifyLanIp("169.254.10.1"), "link-local");
    assert.equal(classifyLanIp("127.0.0.1"), "loopback");
    assert.equal(classifyLanIp("172.15.0.1"), "other"); // just below 172.16
    assert.equal(classifyLanIp("172.32.0.1"), "other"); // just above 172.31
  });

  it("classifies a public/other address and rejects malformed input", () => {
    assert.equal(classifyLanIp("8.8.8.8"), "other");
    assert.equal(classifyLanIp("not-an-ip"), "other");
    assert.equal(classifyLanIp("1.2.3"), "other");
  });
});

describe("isPhoneUnreachableLanIp", () => {
  it("flags CGNAT / link-local / loopback as unreachable", () => {
    assert.equal(isPhoneUnreachableLanIp("100.64.71.114"), true);
    assert.equal(isPhoneUnreachableLanIp("169.254.1.1"), true);
    assert.equal(isPhoneUnreachableLanIp("127.0.0.1"), true);
  });

  it("does NOT flag private or public addresses", () => {
    assert.equal(isPhoneUnreachableLanIp("192.168.1.50"), false);
    assert.equal(isPhoneUnreachableLanIp("10.0.0.5"), false);
    assert.equal(isPhoneUnreachableLanIp("8.8.8.8"), false);
  });
});
