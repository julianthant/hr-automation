import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  processEidNameMismatchMessage,
  verifyUcpathTransactionName,
} from "../../../../src/workflows/process-eid/name-match.js";

describe("verifyUcpathTransactionName", () => {
  test("matches the lived name exactly", () => {
    const verdict = verifyUcpathTransactionName("Sachi Netam", {
      livedName: "Sachi Netam",
    });
    assert.deepEqual(verdict, {
      matched: true,
      tier: "same",
      matchedAgainst: "lived",
      label: "same as Lived Name",
    });
  });

  test("matches the legal name when UCPath does not hold the lived name", () => {
    // Real roster pair: lived "Rita Li", legal "Guangyi Li"; UCPath holds legal.
    const verdict = verifyUcpathTransactionName("Guangyi Li", {
      livedName: "Rita Li",
      legalName: "Guangyi Li",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.matchedAgainst, "legal");
    assert.equal(verdict.label, "same as Legal Name");
  });

  test("a one-edit spelling variant matches, and says so", () => {
    // Real roster pair: lived "Stoney Motooka", legal "Stone Motooka".
    const verdict = verifyUcpathTransactionName("Stone Motooka", {
      livedName: "Stoney Motooka",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.tier, "similar");
    assert.equal(verdict.label, "similar as Lived Name");
  });

  test("prefers the exact match over a merely similar one", () => {
    const verdict = verifyUcpathTransactionName("Stone Motooka", {
      livedName: "Stoney Motooka",
      legalName: "Stone Motooka",
    });
    assert.equal(verdict.tier, "same");
    assert.equal(verdict.matchedAgainst, "legal");
  });

  test("a different person does NOT match either roster name", () => {
    // The live defect this exists for: T002236430 is Riley Lah in UCPath, and
    // the roster listed it against two other people.
    const verdict = verifyUcpathTransactionName("Riley Lah", {
      livedName: "Lyssie ZHU",
      legalName: "WENJIN ZHU",
    });
    assert.deepEqual(verdict, {
      matched: false,
      tier: "different",
      matchedAgainst: "none",
      label: "no roster name matched",
    });
  });

  test("a shortened first name is not proof on its own", () => {
    // "Chris" vs "Christopher" is 6 edits — only the legal name proves this row.
    assert.equal(
      verifyUcpathTransactionName("Christopher Campos", { livedName: "Chris Campos" })
        .matched,
      false,
    );
    assert.equal(
      verifyUcpathTransactionName("Christopher Campos", {
        livedName: "Chris Campos",
        legalName: "Christopher Campos",
      }).matched,
      true,
    );
  });

  test("a blank UCPath name never matches", () => {
    assert.equal(
      verifyUcpathTransactionName("", { livedName: "Sachi Netam" }).matched,
      false,
    );
  });
});

describe("processEidNameMismatchMessage", () => {
  test("names both sides and both roster spellings", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002236430",
      ucpathName: "Riley Lah",
      livedName: "Lyssie ZHU",
      legalName: "WENJIN ZHU",
    });
    assert.match(message, /T002236430 belongs to "Riley Lah" in UCPath/);
    assert.match(message, /"Lyssie ZHU" \(lived\) \/ "WENJIN ZHU" \(legal\)/);
    assert.match(message, /No EID was recorded/);
  });

  test("omits the legal name when the roster has only one spelling", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002235451",
      ucpathName: "Riley Lah",
      livedName: "Sachi Netam",
    });
    assert.match(message, /lists "Sachi Netam"\./);
    assert.doesNotMatch(message, /lived/);
  });
});
