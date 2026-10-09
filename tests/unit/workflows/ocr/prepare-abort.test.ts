import { test } from "vitest";
import assert from "node:assert";
import {
  requestOcrPrepareAbort,
  clearOcrPrepareAbort,
  isOcrPrepareAbortRequested,
  raceOcrPrepWithDiscard,
  createOperatorDiscardError,
  isOperatorDiscardAbortError,
  _resetOcrPrepareAbortRegistryForTests,
} from "../../../../src/workflows/ocr/prepare-abort.js";

test("abort registry request/clear/isRequested", () => {
  _resetOcrPrepareAbortRegistryForTests();
  assert.equal(isOcrPrepareAbortRequested("s", "r"), false);
  requestOcrPrepareAbort("s", "r");
  assert.equal(isOcrPrepareAbortRequested("s", "r"), true);
  clearOcrPrepareAbort("s", "r");
  assert.equal(isOcrPrepareAbortRequested("s", "r"), false);
});

test("raceOcrPrepWithDiscard rejects when discard is requested mid-work", async () => {
  _resetOcrPrepareAbortRegistryForTests();
  const work = new Promise<string>((resolve) => {
    setTimeout(() => resolve("done"), 2_000);
  });
  setTimeout(() => requestOcrPrepareAbort("a", "b"), 50);

  await assert.rejects(
    raceOcrPrepWithDiscard("a", "b", work, 20),
    (err: unknown) => isOperatorDiscardAbortError(err),
  );
  _resetOcrPrepareAbortRegistryForTests();
});

test("createOperatorDiscardError is detected by predicate", () => {
  assert.equal(isOperatorDiscardAbortError(createOperatorDiscardError()), true);
  assert.equal(isOperatorDiscardAbortError(new Error("other")), false);
});
