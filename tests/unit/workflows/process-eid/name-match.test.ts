import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  processEidNameMismatchMessage,
  verifyUcpathTransactionName,
} from "../../../../src/workflows/process-eid/name-match.js";

describe("verifyUcpathTransactionName", () => {
  test("matches the lived name exactly", () => {
    const verdict = verifyUcpathTransactionName("Sepew Nogut", {
      livedName: "Sepew Nogut",
    });
    assert.deepEqual(verdict, {
      matched: true,
      tier: "same",
      matchedAgainst: "lived",
      label: "same as Lived Name",
    });
  });

  test("matches the legal name when UCPath does not hold the lived name", () => {
    // Real roster pair: lived "Ruca La", legal "Guvutoc La"; UCPath holds legal.
    const verdict = verifyUcpathTransactionName("Guvutoc La", {
      livedName: "Ruca La",
      legalName: "Guvutoc La",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.matchedAgainst, "legal");
    assert.equal(verdict.label, "same as Legal Name");
  });

  test("a one-edit spelling variant matches, and says so", () => {
    // Real roster pair: lived "Sacupz Mupocec", legal "Sacup Mupocec".
    const verdict = verifyUcpathTransactionName("Sacup Mupocec", {
      livedName: "Sacupz Mupocec",
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.tier, "similar");
    assert.equal(verdict.label, "similar as Lived Name");
  });

  test("prefers the exact match over a merely similar one", () => {
    const verdict = verifyUcpathTransactionName("Sacup Mupocec", {
      livedName: "Sacupz Mupocec",
      legalName: "Sacup Mupocec",
    });
    assert.equal(verdict.tier, "same");
    assert.equal(verdict.matchedAgainst, "legal");
  });

  test("a different person does NOT match either roster name", () => {
    // The live defect this exists for: T009000066 is Rarof Lis in UCPath, and
    // the roster listed it against two other people.
    const verdict = verifyUcpathTransactionName("Rarof Lis", {
      livedName: "Lawaza ZAP",
      legalName: "WEGAFE ZAP",
    });
    assert.deepEqual(verdict, {
      matched: false,
      tier: "different",
      matchedAgainst: "none",
      label: "no roster name matched",
    });
  });

  test("a shortened first name is not proof on its own", () => {
    // "Cogod" vs "Cuzopacogil" is 6 edits — only the legal name proves this row.
    assert.equal(
      verifyUcpathTransactionName("Cuzopacogil Cuweru", { livedName: "Cogod Cuweru" })
        .matched,
      false,
    );
    assert.equal(
      verifyUcpathTransactionName("Cuzopacogil Cuweru", {
        livedName: "Cogod Cuweru",
        legalName: "Cuzopacogil Cuweru",
      }).matched,
      true,
    );
  });

  test("a blank UCPath name never matches", () => {
    assert.equal(
      verifyUcpathTransactionName("", { livedName: "Sepew Nogut" }).matched,
      false,
    );
  });
});

describe("processEidNameMismatchMessage", () => {
  test("names both sides and both roster spellings", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T009000066",
      ucpathName: "Rarof Lis",
      livedName: "Lawaza ZAP",
      legalName: "WEGAFE ZAP",
    });
    assert.match(message, /T009000066 belongs to "Rarof Lis" in UCPath/);
    assert.match(message, /"Lawaza ZAP" \(lived\) \/ "WEGAFE ZAP" \(legal\)/);
    assert.match(message, /No EID was recorded/);
  });

  test("omits the legal name when the roster has only one spelling", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T009000059",
      ucpathName: "Rarof Lis",
      livedName: "Sepew Nogut",
    });
    assert.match(message, /lists "Sepew Nogut"\./);
    assert.doesNotMatch(message, /lived/);
  });
});
