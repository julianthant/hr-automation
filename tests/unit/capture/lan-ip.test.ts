import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickLanIpFrom } from "../../../src/capture/lan-ip.js";
import type { NetworkInterfaceInfo } from "node:os";

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
});
