import { privateValue } from "../../../../src/private-data.js";
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  processEidNameMismatchMessage,
  verifyUcpathTransactionName,
} from "../../../../src/workflows/process-eid/name-match.js";

describe("verifyUcpathTransactionName", () => {
  test("matches the lived name exactly", () => {
    const verdict = verifyUcpathTransactionName(privateValue("name:83bb613aa947d64e"), {
      livedName: privateValue("name:83bb613aa947d64e"),
    });
    assert.deepEqual(verdict, {
      matched: true,
      tier: "same",
      matchedAgainst: "lived",
      label: "same as Lived Name",
    });
  });

  test("matches the legal name when UCPath does not hold the lived name", () => {
    // Real roster pair: lived "name:d8041f5d6adea3e2", legal "name:48ad2576a56f8612"; UCPath holds legal.
    const verdict = verifyUcpathTransactionName(privateValue("name:48ad2576a56f8612"), {
      livedName: privateValue("name:d8041f5d6adea3e2"),
      legalName: privateValue("name:48ad2576a56f8612"),
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.matchedAgainst, "legal");
    assert.equal(verdict.label, "same as Legal Name");
  });

  test("a one-edit spelling variant matches, and says so", () => {
    // Real roster pair: lived "name:d241f3f03d3a559c", legal "name:6d58f9292628d62e".
    const verdict = verifyUcpathTransactionName(privateValue("name:6d58f9292628d62e"), {
      livedName: privateValue("name:d241f3f03d3a559c"),
    });
    assert.equal(verdict.matched, true);
    assert.equal(verdict.tier, "similar");
    assert.equal(verdict.label, "similar as Lived Name");
  });

  test("prefers the exact match over a merely similar one", () => {
    const verdict = verifyUcpathTransactionName(privateValue("name:6d58f9292628d62e"), {
      livedName: privateValue("name:d241f3f03d3a559c"),
      legalName: privateValue("name:6d58f9292628d62e"),
    });
    assert.equal(verdict.tier, "same");
    assert.equal(verdict.matchedAgainst, "legal");
  });

  test("a different person does NOT match either roster name", () => {
    // The live defect this exists for: T002236430 is name:77130188dc6f12ca in UCPath, and
    // the roster listed it against two other people.
    const verdict = verifyUcpathTransactionName(privateValue("name:77130188dc6f12ca"), {
      livedName: privateValue("name:d08e13c51e091df5"),
      legalName: privateValue("name:75c04f5d30fdc047"),
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
      verifyUcpathTransactionName(privateValue("name:0027d8c4c07cafa4"), { livedName: privateValue("name:427f21ff3767dd07") })
        .matched,
      false,
    );
    assert.equal(
      verifyUcpathTransactionName(privateValue("name:0027d8c4c07cafa4"), {
        livedName: privateValue("name:427f21ff3767dd07"),
        legalName: privateValue("name:0027d8c4c07cafa4"),
      }).matched,
      true,
    );
  });

  test("a blank UCPath name never matches", () => {
    assert.equal(
      verifyUcpathTransactionName("", { livedName: privateValue("name:83bb613aa947d64e") }).matched,
      false,
    );
  });
});

describe("processEidNameMismatchMessage", () => {
  test("names both sides and both roster spellings", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002236430",
      ucpathName: privateValue("name:77130188dc6f12ca"),
      livedName: privateValue("name:d08e13c51e091df5"),
      legalName: privateValue("name:75c04f5d30fdc047"),
    });
    assert.match(message, new RegExp("T002236430 belongs to \"" + privateValue("name:77130188dc6f12ca") + "\" in UCPath"));
    assert.match(message, new RegExp("\"" + privateValue("name:d08e13c51e091df5") + "\" \\(lived\\) \\/ \"" + privateValue("name:75c04f5d30fdc047") + "\" \\(legal\\)"));
    assert.match(message, /No EID was recorded/);
  });

  test("omits the legal name when the roster has only one spelling", () => {
    const message = processEidNameMismatchMessage({
      transactionId: "T002235451",
      ucpathName: privateValue("name:77130188dc6f12ca"),
      livedName: privateValue("name:83bb613aa947d64e"),
    });
    assert.match(message, new RegExp("lists \"" + privateValue("name:83bb613aa947d64e") + "\"\\."));
    assert.doesNotMatch(message, /lived/);
  });
});
