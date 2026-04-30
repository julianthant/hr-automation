import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DUO_POLL_INTERVAL_MS,
  DUO_PRE_CHECK_MS,
  DUO_PRE_CHECK_INTERVAL_MS,
  type DuoPollOptions,
} from "../../../src/auth/duo-poll.js";

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
