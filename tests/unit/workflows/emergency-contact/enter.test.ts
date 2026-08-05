/**
 * Pins the Emergency Contact pre-fill identity gate's page-read helper
 * (`readEmergencyContactPersonIdRow`) and its wiring into the shared
 * `assertDisplayedIdentity` primitive — the gate that stops a stale/wrong UCPath
 * editor from having a contact written onto the wrong person's record.
 *
 * Uses a minimal fake Page (the mock-page pattern from tests/unit/systems/) —
 * no live Playwright.
 *
 * 2026-08-05: the fakes previously modeled
 * `getByText("Person ID").first().locator("..")`. That shape was the BUG: in
 * PeopleSoft the label ("Person ID") and the value (the EID) are SIBLING divs,
 * so the label's parent yields the bare string "Person ID" and the gate
 * correctly reported "the expected identity was not found on the page" against
 * a perfectly loaded editor. The helper now reads the VALUE elements directly
 * (`#PERSON_NPC_VW_EMPLID`, `#PERSON_NAME_NAME`) and composes the header row,
 * so these fakes model `page.locator(id)` instead.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { readEmergencyContactPersonIdRow } from "../../../../src/workflows/emergency-contact/enter.js";
import { assertDisplayedIdentity } from "../../../../src/systems/common/index.js";

interface FakeOpts {
  /** Text of the EID value element; `null` = element absent. */
  emplId: string | null;
  /** Text of the name value element; `null` = element absent. */
  name?: string | null;
  throwCount?: boolean;
  throwInner?: boolean;
}

/**
 * Models `page.locator(sel).or(page.locator(sel2)).first()` with `count()` and
 * `innerText()`. Ids are matched loosely so the fake does not have to restate
 * the exact `.or()` arms the selector uses.
 */
function fakePage(opts: FakeOpts): Page {
  const node = (text: string | null) => ({
    count: async () => {
      if (opts.throwCount) throw new Error("frame detached");
      return text === null ? 0 : 1;
    },
    innerText: async () => {
      if (opts.throwInner) throw new Error("frame detached");
      return text ?? "";
    },
  });

  const pick = (sel: string) => (sel.includes("NAME") ? opts.name ?? null : opts.emplId);

  const locator = (sel: string) => {
    const self = node(pick(sel));
    return {
      ...self,
      or: (_other: unknown) => ({ ...self, first: () => self }),
      first: () => self,
    };
  };

  return { locator } as unknown as Page;
}

describe("readEmergencyContactPersonIdRow", () => {
  it("composes the header row from the EID and name VALUE elements", async () => {
    const page = fakePage({ emplId: "10877384", name: "Jane Doe" });
    assert.equal(
      await readEmergencyContactPersonIdRow(page),
      "Person ID 10877384 Jane Doe Emergency Contact",
    );
  });

  it("still yields a usable identity row when only the EID value is present", async () => {
    const page = fakePage({ emplId: "10877384", name: null });
    assert.equal(
      await readEmergencyContactPersonIdRow(page),
      "Person ID 10877384 Emergency Contact",
    );
  });

  // Regression for the 2026-08-05 root cause: anchoring on the "Person ID"
  // LABEL yielded the literal string "Person ID" with no EID in it, so the gate
  // reported a hard identity miss on a correctly-loaded page. A label-only read
  // must never satisfy the gate.
  it("does not accept a label-only read as an identity", async () => {
    const page = fakePage({ emplId: "", name: null });
    assert.equal(await readEmergencyContactPersonIdRow(page), null);
  });

  // `null` (not "") means "not rendered YET" — a retryable state the identity
  // gate polls on.
  it("returns null when the EID value has not rendered yet", async () => {
    assert.equal(await readEmergencyContactPersonIdRow(fakePage({ emplId: null })), null);
  });

  it("propagates a count() exception instead of reporting the header absent", async () => {
    // A swallowed count() would read as "no header" and fail the gate with the
    // WRONG reason ("not found" rather than "could not read").
    await assert.rejects(
      () => readEmergencyContactPersonIdRow(fakePage({ emplId: "10877384", throwCount: true })),
      /frame detached/,
    );
  });

  it("propagates an innerText exception (so the gate fails loud, not false-miss)", async () => {
    await assert.rejects(
      readEmergencyContactPersonIdRow(fakePage({ emplId: "10877384", throwInner: true })),
      /frame detached/,
    );
  });
});

describe("emergency-contact identity gate wiring", () => {
  it("passes when the loaded editor shows the intended employee id", async () => {
    const page = fakePage({ emplId: "10877384", name: "Jane Doe" });
    await assertDisplayedIdentity({
      expected: "10877384",
      context: "Emergency Contact (Jane Doe)",
      extract: () => readEmergencyContactPersonIdRow(page),
    });
  });

  it("throws naming the wrong id when the editor shows a different employee", async () => {
    const page = fakePage({ emplId: "10999999", name: "Someone Else" });
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
    const page = fakePage({ emplId: null });
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
