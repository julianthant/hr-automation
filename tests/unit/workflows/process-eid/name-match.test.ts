import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  processEidNameMismatchMessage,
  verifyUcpathTransactionName,
} from "../../../../src/workflows/process-eid/name-match.js";

describe("verifyUcpathTransactionName", () => {
  test("matches the lived name exactly", () => {
    const verdict = verifyUcpathTransactionName("Person 1780", {
      livedName: "Person 1780",
    });
    assert.deepEqual(verdict, {
      matched: true,
      tier: "same",
      matchedAgainst: "lived",
      label: "same as Lived Name",
    });
  });

  test("matches the legal name when UCPath does not hold the lived name", () => {
    // Real roster pair: lived "Person 1734", legal "Person 756"; UCPath holds legal.
    const verdict = verifyUcpathTransactionName("Person 756", {
      livedName: "Person 1734",
      legalName: "Person 756",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.matchedAgainst, "legal");
    assert.equal(verdict.label, "same as Legal Name");
  });

  test("a one-edit spelling variant matches, and says so", () => {
    // Real roster pair: lived "Person 1937", legal "Person 1936".
    const verdict = verifyUcpathTransactionName("Person 1936", {
      livedName: "Person 1937",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.tier, "similar");
    assert.equal(verdict.label, "similar as Lived Name");
  });

  test("prefers the exact match over a merely similar one", () => {
    const verdict = verifyUcpathTransactionName("Person 1936", {
      livedName: "Person 1937",
      legalName: "Person 1936",
    });
    assert.equal(verdict.tier, "same");
    assert.equal(verdict.matchedAgainst, "legal");
  });

  test("a different person does NOT match either roster name", () => {
    // The live defect this exists for: T002236430 is Person 1728 in UCPath, and
    // the roster listed it against two other people.
    const verdict = verifyUcpathTransactionName("Person 1728", {
      livedName: "Person 1357",
      legalName: "Person 2090",
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
      verifyUcpathTransactionName("Person 439", { livedName: "Person 420" })
        .matched,
      false,
    );
    assert.equal(
      verifyUcpathTransactionName("Person 439", {
        livedName: "Person 420",
        legalName: "Person 439",
      }).matched,
      true,
    );
  });

  test("a blank UCPath name never matches", () => {
    assert.equal(
      verifyUcpathTransactionName("", { livedName: "Person 1780" }).matched,
      false,
    );
  });
});

describe("processEidNameMismatchMessage", () => {
  test("names both sides and both roster spellings", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002236430",
      ucpathName: "Person 1728",
      livedName: "Person 1357",
      legalName: "Person 2090",
    });
    assert.match(message, /T002236430 belongs to "Person 1728" in UCPath/);
    assert.match(message, /"Person 1357" \(lived\) \/ "Person 2090" \(legal\)/);
    assert.match(message, /No EID was recorded/);
  });

  test("omits the legal name when the roster has only one spelling", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002235451",
      ucpathName: "Person 1728",
      livedName: "Person 1780",
    });
    assert.match(message, /lists "Person 1780"\./);
    assert.doesNotMatch(message, /lived/);
  });
});
