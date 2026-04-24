import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLastDayWorked } from "../../../../src/workflows/separations/schema.js";

describe("validateLastDayWorked", () => {
  it("passes when date is today", () => {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const yyyy = today.getFullYear();
    assert.doesNotThrow(() => validateLastDayWorked(`${mm}/${dd}/${yyyy}`));
  });

  it("passes when date is yesterday", () => {
    const y = new Date(Date.now() - 86_400_000);
    const mm = String(y.getMonth() + 1).padStart(2, "0");
    const dd = String(y.getDate()).padStart(2, "0");
    const yyyy = y.getFullYear();
    assert.doesNotThrow(() => validateLastDayWorked(`${mm}/${dd}/${yyyy}`));
  });

  it("passes for dates in the distant past", () => {
    assert.doesNotThrow(() => validateLastDayWorked("01/01/2020"));
  });

  it("throws when date is tomorrow", () => {
    const t = new Date(Date.now() + 86_400_000);
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const dd = String(t.getDate()).padStart(2, "0");
    const yyyy = t.getFullYear();
    assert.throws(
      () => validateLastDayWorked(`${mm}/${dd}/${yyyy}`),
      /cannot be in the future/,
    );
  });

  it("throws for dates 1 year out", () => {
    const now = new Date();
    const future = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear() + 1}`;
    assert.throws(
      () => validateLastDayWorked(future),
      /cannot be in the future/,
    );
  });

  it("includes the offending date in the error message", () => {
    const now = new Date();
    const future = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear() + 1}`;
    assert.throws(
      () => validateLastDayWorked(future),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes(future),
          `Expected error message to include "${future}", got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  it("uses the custom fieldLabel in the error message", () => {
    const now = new Date();
    const future = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear() + 1}`;
    assert.throws(
      () => validateLastDayWorked(future, "Separation Date"),
      /Separation Date/,
    );
  });
});
