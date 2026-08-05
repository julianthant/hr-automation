/**
 * Pins the Emergency Contact pre-fill identity gate's page-read helper
 * (`readEmergencyContactPersonIdRow`) and its wiring into the shared
 * `assertDisplayedIdentity` primitive — the gate that stops a stale/wrong UCPath
 * editor from having a contact written onto the wrong person's record.
 *
 * Uses a minimal fake Page (the mock-page pattern from tests/unit/systems/) —
 * no live Playwright.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { readEmergencyContactPersonIdRow } from "../../../../src/workflows/emergency-contact/enter.js";
import { assertDisplayedIdentity } from "../../../../src/systems/common/index.js";

/** Fake Page modeling `getByText("Person ID").first().locator("..").innerText()`. */
function fakePage(opts: { count: number; rowText?: string; throwInner?: boolean }): Page {
  const parent = {
    innerText: async () => {
      if (opts.throwInner) throw new Error("frame detached");
      return opts.rowText ?? "";
    },
  };
  const first = {
    count: async () => opts.count,
    locator: (_sel: string) => parent,
  };
  return {
    getByText: (_t: string) => ({ first: () => first }),
  } as unknown as Page;
}

describe("readEmergencyContactPersonIdRow", () => {
  it("returns the trimmed header row text when the Person ID header is present", async () => {
    const page = fakePage({
      count: 1,
      rowText: "  Person ID 10877384 Jane Doe Emergency Contact  ",
    });
    assert.equal(
      await readEmergencyContactPersonIdRow(page),
      "Person ID 10877384 Jane Doe Emergency Contact",
    );
  });

  // `null` (not "") means "not rendered YET" — a retryable state the identity
  // gate polls on. Returning "" made a still-painting header indistinguishable
  // from a genuine miss, which is how the 2026-08-05 batch failed all 13 records
  // with "expected identity was not found" against correctly-loaded pages.
  it("returns null when the Person ID header has not rendered yet", async () => {
    assert.equal(await readEmergencyContactPersonIdRow(fakePage({ count: 0 })), null);
  });

  it("propagates a count() exception instead of reporting the header absent", async () => {
    const page = {
      getByText: (_t: string) => ({
        first: () => ({
          count: async () => {
            throw new Error("frame detached");
          },
          locator: (_sel: string) => ({ innerText: async () => "" }),
        }),
      }),
    } as unknown as Page;
    // A swallowed count() would read as "no header" and fail the gate with the
    // WRONG reason ("not found" rather than "could not read").
    await assert.rejects(() => readEmergencyContactPersonIdRow(page), /frame detached/);
  });

  it("propagates an innerText exception (so the gate fails loud, not false-miss)", async () => {
    await assert.rejects(
      readEmergencyContactPersonIdRow(fakePage({ count: 1, throwInner: true })),
      /frame detached/,
    );
  });
});

describe("emergency-contact identity gate wiring", () => {
  it("passes when the loaded editor shows the intended employee id", async () => {
    const page = fakePage({ count: 1, rowText: "Person ID 10877384 Jane Doe Emergency Contact" });
    await assertDisplayedIdentity({
      expected: "10877384",
      context: "Emergency Contact (Jane Doe)",
      extract: () => readEmergencyContactPersonIdRow(page),
    });
  });

  it("throws naming the wrong id when the editor shows a different employee", async () => {
    const page = fakePage({ count: 1, rowText: "Person ID 10999999 Someone Else Emergency Contact" });
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10877384",
        context: "Emergency Contact (Jane Doe)",
        extract: () => readEmergencyContactPersonIdRow(page),
      }),
      (err: Error) => /10877384/.test(err.message) && /10999999/.test(err.message),
    );
  });

  it("throws (fails loud) when the editor header is missing entirely", async () => {
    const page = fakePage({ count: 0 });
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10877384",
        context: "Emergency Contact (Jane Doe)",
        extract: () => readEmergencyContactPersonIdRow(page),
      }),
      /was not found on the page/,
    );
  });
});
