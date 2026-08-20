import { describe, test } from "vitest";
import assert from "node:assert/strict";
import type { FrameLocator, Locator, Page } from "playwright";
import {
  extractSmartHrTransactionNumber,
  rowMatchesTerminationEid,
  classifyOutcomeSignals,
  parsePayRate,
  waitForNamedCondition,
  interpretPostSubmitTxnReadback,
  classifyTxnApprovalStatus,
  assertTerminationLastDateWorkedReadback,
  requirePeopleSoftControlRefresh,
  fillTerminationLastDateWorked,
  classifySubmitSignals,
  decidePersonMatchContinue,
  candidateExcludedByHardIdentifier,
  normalizeNationalIdLast4,
  normalizeDobMonthDay,
  ssnLast4,
  formatPersonMatchCandidate,
  type PersonMatchCandidate,
} from "../../../../src/systems/ucpath/transaction.js";

describe("requirePeopleSoftControlRefresh", () => {
  test("waits for the original control to detach even when no spinner is observed", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let actionRan = false;
    let disposed = false;
    const locator = {
      elementHandle: async () => ({
        waitForElementState: async () => refresh,
        dispose: async () => {
          disposed = true;
        },
      }),
    } as unknown as Locator;

    let settled = false;
    const pending = requirePeopleSoftControlRefresh(
      locator,
      async () => {
        actionRan = true;
      },
      "test control",
    ).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(actionRan, true);
    assert.equal(settled, false, "must not read back before the old fragment detaches");
    releaseRefresh?.();
    await pending;
    assert.equal(disposed, true);
  });

  test("fails loud when the original control never refreshes", async () => {
    let disposed = false;
    const locator = {
      elementHandle: async () => ({
        waitForElementState: async () => {
          throw new Error("Timeout 15000ms exceeded (fake no-rerender)");
        },
        dispose: async () => {
          disposed = true;
        },
      }),
    } as unknown as Locator;

    await assert.rejects(
      requirePeopleSoftControlRefresh(locator, async () => undefined, "test control"),
      /did not detach\/hide.*no-rerender/i,
    );
    assert.equal(disposed, true);
  });
});

/**
 * The two termination controls need OPPOSITE waits, live-verified 2026-07-28 on
 * the editable UC_VOL_TERM form:
 *   - the override checkbox's onclick runs `submitAction_win0` → the fragment
 *     re-renders and the old node detaches, so the check must wait for it;
 *   - the Last Date Worked input's only handler is `addchg_win0` (dirty flag,
 *     no round-trip) → after fill + Tab the SAME node is still connected, so
 *     requiring a detach there could only ever time out.
 * Gating the date write on a refresh is exactly the bug this pins.
 */
describe("fillTerminationLastDateWorked", () => {
  function terminationPageFake(opts: { initiallyChecked: boolean; readbackValue?: string }) {
    const events: string[] = [];
    let checked = opts.initiallyChecked;
    let value = "";

    const handle = {
      waitForElementState: async (state: string) => {
        events.push(`checkbox:awaitState:${state}`);
      },
      dispose: async () => {},
    };

    const checkbox = {
      isChecked: async () => checked,
      check: async () => {
        checked = true;
        events.push("checkbox:check");
      },
      elementHandle: async () => {
        events.push("checkbox:elementHandle");
        return handle;
      },
    } as unknown as Locator;

    const dateInput = {
      fill: async (v: string) => {
        value = v;
        events.push("date:fill");
      },
      press: async (key: string) => {
        events.push(`date:press:${key}`);
      },
      waitFor: async () => {
        events.push("date:waitFor");
      },
      inputValue: async () => opts.readbackValue ?? value,
      elementHandle: async () => {
        // Reaching here means the date write was gated on a fragment refresh.
        events.push("date:elementHandle");
        return null;
      },
    } as unknown as Locator;

    // No spinner in the fake — waitForPeopleSoftProcessing swallows the miss.
    const spinner = {
      first: () => ({ waitFor: async () => { throw new Error("no spinner (fake)"); } }),
    } as unknown as Locator;

    const frame = {
      locator: (selector: string): Locator => {
        if (selector.includes("CHK2")) return checkbox;
        if (selector.includes("_DATE$")) return dateInput;
        return spinner;
      },
    } as unknown as FrameLocator;

    const page = { evaluate: async () => undefined } as unknown as Page;

    return { page, frame, events, readValue: () => value };
  }

  test("writes and verifies without gating the date field on a fragment refresh", async () => {
    const fake = terminationPageFake({ initiallyChecked: true });

    await fillTerminationLastDateWorked(fake.page, fake.frame, "06/09/2026");

    assert.equal(fake.readValue(), "06/09/2026");
    assert.ok(fake.events.includes("date:fill"));
    assert.ok(fake.events.includes("date:press:Tab"), "blur commits the value (change → addchg_win0)");
    assert.ok(
      !fake.events.includes("date:elementHandle"),
      "the date input must NOT be required to detach — it has no PeopleSoft round-trip",
    );
    // Already checked → no redundant click/round-trip on the override.
    assert.ok(!fake.events.includes("checkbox:check"));
  });

  test("waits for the override's fragment refresh when it starts unchecked", async () => {
    const fake = terminationPageFake({ initiallyChecked: false });

    await fillTerminationLastDateWorked(fake.page, fake.frame, "06/09/2026");

    // The detach-wait is ARMED before the click — a fragment that re-renders
    // faster than the await is set up would otherwise be missed.
    assert.deepEqual(
      fake.events.filter((e) => e.startsWith("checkbox:")),
      ["checkbox:elementHandle", "checkbox:awaitState:hidden", "checkbox:check"],
    );
    // …and the date is only written once that refresh has settled.
    assert.ok(
      fake.events.indexOf("checkbox:awaitState:hidden") < fake.events.indexOf("date:fill"),
    );
  });

  test("fails loud when the readback does not match what was written", async () => {
    const fake = terminationPageFake({ initiallyChecked: true, readbackValue: "06/12/2026" });

    await assert.rejects(
      fillTerminationLastDateWorked(fake.page, fake.frame, "06/09/2026"),
      /readback mismatch: expected "06\/09\/2026", got "06\/12\/2026"/,
    );
  });

  test("rejects a malformed date before touching the page", async () => {
    const fake = terminationPageFake({ initiallyChecked: true });

    await assert.rejects(
      fillTerminationLastDateWorked(fake.page, fake.frame, "2026-06-09"),
      /malformed \(expected MM\/DD\/YYYY\)/,
    );
    assert.deepEqual(fake.events, []);
  });
});

describe("assertTerminationLastDateWorkedReadback", () => {
  test("accepts only a checked override and an exact normalized date", () => {
    assert.doesNotThrow(() =>
      assertTerminationLastDateWorkedReadback(true, " 06/14/2026 ", "06/14/2026"),
    );
  });

  test("rejects an unchecked override", () => {
    assert.throws(
      () => assertTerminationLastDateWorkedReadback(false, "06/14/2026", "06/14/2026"),
      /override.*not checked/i,
    );
  });

  test("rejects a blank or mismatched Last Date Worked value", () => {
    assert.throws(
      () => assertTerminationLastDateWorkedReadback(true, "", "06/14/2026"),
      /blank/i,
    );
    assert.throws(
      () => assertTerminationLastDateWorkedReadback(true, "06/12/2026", "06/14/2026"),
      /expected.*06\/14\/2026.*06\/12\/2026/i,
    );
  });
});

/**
 * Minimal fake Locator for waitForNamedCondition: records the waitFor options
 * it received and resolves/rejects per the injected behavior.
 */
function fakeLocator(behavior: {
  resolve: boolean;
  onWaitFor?: (opts: { state?: string; timeout?: number }) => void;
}): Locator {
  const self = {
    first: () => self,
    waitFor: (opts: { state?: string; timeout?: number }): Promise<void> => {
      behavior.onWaitFor?.(opts);
      return behavior.resolve
        ? Promise.resolve()
        : Promise.reject(new Error("Timeout 123ms exceeded (fake)"));
    },
  };
  return self as unknown as Locator;
}

describe("parsePayRate", () => {
  test("extracts the numeric rate from a formatted wage", () => {
    assert.equal(parsePayRate("$17.75 per hour"), "17.75");
    assert.equal(parsePayRate("20"), "20");
    assert.equal(parsePayRate("$18.50"), "18.50");
  });
  test("throws (fail loud) on a digit-free wage instead of submitting it verbatim", () => {
    // "TBD"/"Negotiable"/"N/A" would previously be typed straight into the
    // UCPath Compensation Rate field; now they fail loud.
    assert.throws(() => parsePayRate("TBD"), /unparseable pay rate/);
    assert.throws(() => parsePayRate("Negotiable"), /unparseable pay rate/);
    assert.throws(() => parsePayRate("N/A"), /unparseable pay rate/);
  });
  test("handles comma-formatted wages instead of truncating at the comma", () => {
    // The old /[\d.]+/ stopped at the first comma: "$1,250.00" → "1" — a wrong
    // rate typed into a real UCPath transaction.
    assert.equal(parsePayRate("$1,250.00"), "1250.00");
    assert.equal(parsePayRate("$1,250.00 biweekly"), "1250.00");
    assert.equal(parsePayRate("$12,345.67"), "12345.67");
  });
  test("throws on malformed digit-separator grouping instead of guessing", () => {
    // Stripping the comma from "1,25.00" would silently submit 125.
    assert.throws(() => parsePayRate("$1,25.00"), /ambiguous digit separators/);
    assert.throws(() => parsePayRate("$12,3456"), /ambiguous digit separators/);
  });
});

test("extractSmartHrTransactionNumber reads the lower Transaction ID field", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Transaction ID:\n\nT002144847\nInitiator Comments: ..."),
    "T002144847",
  );
});

test("extractSmartHrTransactionNumber reads the approval strip transaction label", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Transaction: T002144847, ID: 10783653, Effdt: 2026-05-18, Unit: SDCMP:Pending"),
    "T002144847",
  );
});

test("extractSmartHrTransactionNumber returns null when no T-number is present", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Enter Transaction Information\nTransaction ID:\nNEW"),
    null,
  );
});

describe("rowMatchesTerminationEid", () => {
  test("exact EID in a termination row → true", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["John Smith", "10694136", "TER Termination"],
        "10694136 John Smith TER Termination Pending",
        "10694136",
      ),
      true,
    );
  });

  test("EID present but row not a termination → false", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["10694136", "HIR Hire"],
        "10694136 John Smith HIR Hire Approved",
        "10694136",
      ),
      false,
    );
  });

  test("EID only as substring of a larger cell value → false", () => {
    // cell "10694136X" contains "1069413" but must not match eid "1069413"
    assert.equal(
      rowMatchesTerminationEid(
        ["10694136X", "TER Termination"],
        "10694136X TER Termination Pending",
        "1069413",
      ),
      false,
    );
  });

  test("no cell matches the EID → false", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["Jane Doe", "DEPT001", "TER Termination"],
        "Jane Doe DEPT001 TER Termination Pending",
        "10694136",
      ),
      false,
    );
  });
});

/**
 * The per-tick decision behind `waitForTransactionOutcome`. The bug it guards:
 * a late-rendering error banner read `count() === 0` at a single sampled instant
 * and returned `{ success: true }` for a transaction that actually errored. The
 * decision now requires a positive success marker OR treats a visible error
 * banner as authoritative — with the error banner winning even a tie.
 */
describe("classifyOutcomeSignals", () => {
  test("error banner visible → 'error' (even when the success marker is also visible)", () => {
    assert.equal(classifyOutcomeSignals(true, true), "error");
  });

  test("error banner only → 'error'", () => {
    assert.equal(classifyOutcomeSignals(true, false), "error");
  });

  test("success marker only → 'success'", () => {
    assert.equal(classifyOutcomeSignals(false, true), "success");
  });

  test("neither signal yet → 'pending' (keep polling, do not conclude success)", () => {
    assert.equal(classifyOutcomeSignals(false, false), "pending");
  });
});

/**
 * The bounded named-condition wait that replaced the fixed waitForTimeout
 * sleeps (2026-07-06). Contract: waits for a SPECIFIC element state, defaults
 * to "visible", honors an explicit "hidden" (wizard-left-the-page conditions),
 * and NEVER throws on timeout — it returns false so the caller proceeds to its
 * own actionability-checked action (worst case strictly no worse than the old
 * sleep).
 */
describe("waitForNamedCondition", () => {
  test("returns true when the element reaches the state within the cap", async () => {
    const seen: Array<{ state?: string; timeout?: number }> = [];
    const ok = await waitForNamedCondition(
      fakeLocator({ resolve: true, onWaitFor: (o) => seen.push(o) }),
      { timeoutMs: 5_000, label: "test condition" },
    );
    assert.equal(ok, true);
    // Defaults to "visible" and passes the cap through as the waitFor timeout.
    assert.deepEqual(seen, [{ state: "visible", timeout: 5_000 }]);
  });

  test("passes state:'hidden' through for wizard-advanced conditions", async () => {
    const seen: Array<{ state?: string; timeout?: number }> = [];
    const ok = await waitForNamedCondition(
      fakeLocator({ resolve: true, onWaitFor: (o) => seen.push(o) }),
      { timeoutMs: 16_000, label: "reason-code page gone", state: "hidden" },
    );
    assert.equal(ok, true);
    assert.deepEqual(seen, [{ state: "hidden", timeout: 16_000 }]);
  });

  test("returns false (does NOT throw) when the condition never resolves", async () => {
    const ok = await waitForNamedCondition(
      fakeLocator({ resolve: false }),
      { timeoutMs: 100, label: "never-appearing element" },
    );
    assert.equal(ok, false);
  });
});

/**
 * Approval-status classification for a post-submit receipt. Only the statuses
 * the live Approval Status combobox actually exposes (plus the two extra values
 * the grid parser recognizes) are classified; everything else stays `unknown`
 * so an unreadable status can never drift into "approved".
 */
describe("classifyTxnApprovalStatus", () => {
  test("the accepted statuses are the only ones that classify as accepted", () => {
    for (const s of ["Approved", "approved", "  APPROVED ", "Manually Processed", "manually  processed"]) {
      assert.equal(classifyTxnApprovalStatus(s), "accepted");
    }
  });

  test("Pending is its own outcome — neither accepted nor refused", () => {
    for (const s of ["Pending", " pending "]) {
      assert.equal(classifyTxnApprovalStatus(s), "pending");
    }
  });

  test("every terminal-failed status classifies as refused", () => {
    for (const s of ["Denied", "Error", "Pushed Back", "pushed  back", "Recycled", "Cancelled", "Canceled"]) {
      assert.equal(classifyTxnApprovalStatus(s), "refused");
    }
  });

  test("blank / unrecognized statuses stay unknown — never optimistically accepted", () => {
    for (const s of ["", "   ", null, undefined, "Saved", "Needs Review", "Approve", "OK"]) {
      assert.equal(classifyTxnApprovalStatus(s), "unknown");
    }
  });
});

/**
 * Post-submit RECEIPT decision (onboarding readback).
 *
 * The rule it pins: success is proved by the PAIR
 * `(transactionNumber, approvalStatus)`, NEVER by the number alone. UCPath
 * issues a `T…` number regardless of outcome — live `T002204014` is a
 * well-formed number on a **Denied** transaction — so the old number-only shape
 * stamped a refused UCPath transaction as a successful receipt (defect found +
 * fixed 2026-08-04).
 *
 * The number is still validated first (`T` + ≥6 digits): anything else — empty
 * readback, the literal "NEW" the Person ID column renders for unprocessed
 * hires, a stray grid value — maps to the explicit `submittedWithoutTxnNumber`
 * marker instead of a plausible-but-wrong number (fail-loud rule).
 */
describe("interpretPostSubmitTxnReadback", () => {
  test("an Approved receipt is a success — number uppercased and trimmed", () => {
    assert.deepEqual(interpretPostSubmitTxnReadback("T002114817", "Approved"), {
      transactionNumber: "T002114817",
      approvalStatus: "Approved",
      outcome: "accepted",
      submittedWithoutTxnNumber: false,
      accepted: true,
    });
    assert.deepEqual(interpretPostSubmitTxnReadback("  t002144847 ", " Manually  Processed "), {
      transactionNumber: "T002144847",
      approvalStatus: "Manually Processed",
      outcome: "accepted",
      submittedWithoutTxnNumber: false,
      accepted: true,
    });
  });

  test("a DENIED receipt with a valid T-number is NOT a success (live T002204014)", () => {
    // The defect this pins: T002204014 is Denied on live UCPath and carries a
    // perfectly well-formed transaction number. The number-only interpreter
    // reported it as a successful receipt.
    const denied = interpretPostSubmitTxnReadback("T002204014", "Denied");
    assert.equal(denied.accepted, false);
    assert.equal(denied.outcome, "refused");
    // The number is still carried, for the audit trail — but not as success.
    assert.equal(denied.transactionNumber, "T002204014");
    assert.equal(denied.approvalStatus, "Denied");
    assert.equal(denied.submittedWithoutTxnNumber, false);

    for (const refused of ["Error", "Pushed Back", "Recycled", "Cancelled"]) {
      const r = interpretPostSubmitTxnReadback("T002204014", refused);
      assert.equal(r.outcome, "refused", `${refused} must be refused`);
      assert.equal(r.accepted, false, `${refused} must not be accepted`);
    }
  });

  test("a PENDING receipt is a distinct intermediate — not success, not failure", () => {
    const pending = interpretPostSubmitTxnReadback("T002204015", "Pending");
    assert.equal(pending.outcome, "pending");
    assert.equal(pending.accepted, false);
    assert.equal(pending.transactionNumber, "T002204015");
    assert.equal(pending.submittedWithoutTxnNumber, false);
  });

  test("an unreadable / absent approval status fails loud as unknown, never as approved", () => {
    for (const miss of ["", "   ", null, undefined, "???"]) {
      const r = interpretPostSubmitTxnReadback("T002114817", miss);
      assert.equal(r.outcome, "unknown", `status ${JSON.stringify(miss)} must be unknown`);
      assert.equal(r.accepted, false);
      // Distinguishable from "no number at all": the number IS known here.
      assert.equal(r.submittedWithoutTxnNumber, false);
      assert.equal(r.transactionNumber, "T002114817");
    }
  });

  test("empty / null / undefined readback → submittedWithoutTxnNumber marker", () => {
    for (const miss of ["", "   ", null, undefined]) {
      assert.deepEqual(interpretPostSubmitTxnReadback(miss, "Approved"), {
        transactionNumber: "",
        approvalStatus: "Approved",
        outcome: "unknown",
        submittedWithoutTxnNumber: true,
        accepted: false,
      });
    }
  });

  test("non-txn-shaped values are NOT stamped as numbers, even with an Approved status", () => {
    // "NEW" is what the Smart HR Person ID column renders for an unprocessed
    // hire; "T12345" is too short to be a real transaction id.
    for (const bogus of ["NEW", "T12345", "002114817", "TXN"]) {
      const r = interpretPostSubmitTxnReadback(bogus, "Approved");
      assert.equal(r.transactionNumber, "");
      assert.equal(r.submittedWithoutTxnNumber, true);
      assert.equal(r.outcome, "unknown");
      assert.equal(r.accepted, false);
    }
  });
});

// ─── Submit-time "Person Match Found" page (2026-08-20) ──────────────────────
//
// Candidate tables below are the LIVE ones from the two blind timeouts that
// motivated this guard (runs ebd5d59e Emily Robles / 99d5012c Hao Sun).

const ROBLES_HIRE = { ssnLast4: "4267", dob: "08/26/2007" };
const ROBLES_CANDIDATES: PersonMatchCandidate[] = [
  { personId: "10773675", firstName: "Emily", lastName: "Robles", nationalIdLast4: "9035", dobMonthDay: "10/8" },
];

const SUN_HIRE = { ssnLast4: "", dob: "08/24/2003" }; // no SSN (CRM 999-99-9999 placeholder)
const SUN_CANDIDATES: PersonMatchCandidate[] = [
  { personId: "10197468", firstName: "Haoyuan", lastName: "Sun", nationalIdLast4: "2188", dobMonthDay: "9/30" },
  { personId: "10291151", firstName: "Haojun", lastName: "Sun", nationalIdLast4: "9960", dobMonthDay: "1/2" },
  { personId: "10416504", firstName: "Haotian", lastName: "Sun", nationalIdLast4: "3380", dobMonthDay: "" },
  { personId: "10489194", firstName: "Haochen", lastName: "Sun", nationalIdLast4: "1919", dobMonthDay: "8/22" },
  { personId: "10568124", firstName: "Haoran", lastName: "Sun", nationalIdLast4: "6160", dobMonthDay: "7/10" },
  { personId: "10682951", firstName: "Hao Yu", lastName: "Sun", nationalIdLast4: "4488", dobMonthDay: "1/29" },
  { personId: "10690473", firstName: "Haoran", lastName: "Sun", nationalIdLast4: "9778", dobMonthDay: "1/15" },
  { personId: "10743545", firstName: "Haowen", lastName: "Sun", nationalIdLast4: "", dobMonthDay: "" },
  { personId: "10823228", firstName: "Haotian", lastName: "Sun", nationalIdLast4: "5916", dobMonthDay: "4/10" },
  { personId: "10839930", firstName: "Hao", lastName: "Sun", nationalIdLast4: "", dobMonthDay: "11/24" },
];

describe("Person Match Found — normalizers", () => {
  test("normalizeNationalIdLast4 keeps only a trailing 4-digit group", () => {
    assert.equal(normalizeNationalIdLast4("*****9035"), "9035");
    assert.equal(normalizeNationalIdLast4("*****XXXX"), "");
    assert.equal(normalizeNationalIdLast4(""), "");
    assert.equal(normalizeNationalIdLast4(undefined), "");
  });

  test("normalizeDobMonthDay accepts masked and full dates and canonicalizes M/D", () => {
    assert.equal(normalizeDobMonthDay("10/8/****"), "10/8");
    assert.equal(normalizeDobMonthDay("08/26/2007"), "8/26");
    assert.equal(normalizeDobMonthDay("8/26"), "8/26");
    assert.equal(normalizeDobMonthDay(""), "");
    assert.equal(normalizeDobMonthDay("13/40/2000"), "");
    assert.equal(normalizeDobMonthDay("not a date"), "");
  });

  test("ssnLast4 reads the last 4 digits in any punctuation, '' when absent", () => {
    assert.equal(ssnLast4("123-45-6789"), "6789");
    assert.equal(ssnLast4("4267"), "4267");
    assert.equal(ssnLast4(""), "");
    assert.equal(ssnLast4(undefined), "");
  });
});

describe("candidateExcludedByHardIdentifier", () => {
  test("DOB month/day known on both sides and different → excluded", () => {
    assert.equal(candidateExcludedByHardIdentifier(ROBLES_CANDIDATES[0], ROBLES_HIRE), true);
  });

  test("SSN last-4 known on both sides and different → excluded even when DOB is unknown", () => {
    const c: PersonMatchCandidate = { personId: "10000001", firstName: "A", lastName: "B", nationalIdLast4: "1111", dobMonthDay: "" };
    assert.equal(candidateExcludedByHardIdentifier(c, { ssnLast4: "2222", dob: "" }), true);
  });

  test("identifier unknown on either side → NOT excluded (cannot tell them apart)", () => {
    // Haowen Sun: no DOB, no SSN shown; hire has no SSN → nothing comparable.
    assert.equal(candidateExcludedByHardIdentifier(SUN_CANDIDATES[7], SUN_HIRE), false);
    // Haotian 10416504: has SSN but the hire has none; DOB blank on the candidate.
    assert.equal(candidateExcludedByHardIdentifier(SUN_CANDIDATES[2], SUN_HIRE), false);
  });

  test("same DOB and same SSN last-4 → NOT excluded (this may well be the person)", () => {
    const c: PersonMatchCandidate = { personId: "10000002", firstName: "Emily", lastName: "Robles", nationalIdLast4: "4267", dobMonthDay: "8/26" };
    assert.equal(candidateExcludedByHardIdentifier(c, ROBLES_HIRE), false);
  });

  test("a different NAME alone is never evidence", () => {
    const c: PersonMatchCandidate = { personId: "10000003", firstName: "Zelda", lastName: "Qwerty", nationalIdLast4: "", dobMonthDay: "" };
    assert.equal(candidateExcludedByHardIdentifier(c, ROBLES_HIRE), false);
  });
});

describe("decidePersonMatchContinue", () => {
  test("Emily Robles live case: the lone namesake differs on DOB and SSN → proceed automatically", () => {
    const d = decidePersonMatchContinue(ROBLES_CANDIDATES, ROBLES_HIRE, []);
    assert.equal(d.proceed, true);
    assert.deepEqual(d.unresolved, []);
    assert.deepEqual(d.reasons, [{ personId: "10773675", reason: "hard-identifier-mismatch" }]);
  });

  test("Hao Sun live case, no operator review: two candidates lack any comparable identifier → refuse", () => {
    const d = decidePersonMatchContinue(SUN_CANDIDATES, SUN_HIRE, []);
    assert.equal(d.proceed, false);
    assert.deepEqual(d.unresolved.map((c) => c.personId), ["10416504", "10743545"]);
    // The exact-name one (Hao Sun 10839930) is excluded by DOB 11/24 ≠ 8/24, not by name.
    assert.deepEqual(d.reasons.find((r) => r.personId === "10839930"), { personId: "10839930", reason: "hard-identifier-mismatch" });
  });

  test("Hao Sun live case with the two unresolved EIDs operator-reviewed → proceed", () => {
    const d = decidePersonMatchContinue(SUN_CANDIDATES, SUN_HIRE, ["10416504", "10743545"]);
    assert.equal(d.proceed, true);
    assert.deepEqual(d.reasons.filter((r) => r.reason === "operator-reviewed").map((r) => r.personId), ["10416504", "10743545"]);
  });

  test("operator review of OTHER EIDs does not cover an unreviewed, unexcluded candidate", () => {
    const d = decidePersonMatchContinue(SUN_CANDIDATES, SUN_HIRE, ["10416504"]);
    assert.equal(d.proceed, false);
    assert.deepEqual(d.unresolved.map((c) => c.personId), ["10743545"]);
  });

  test("an operator-reviewed EID that ALSO matches on hard identifiers is still honoured (operator decision wins)", () => {
    const c: PersonMatchCandidate = { personId: "10000004", firstName: "Emily", lastName: "Robles", nationalIdLast4: "4267", dobMonthDay: "8/26" };
    assert.equal(decidePersonMatchContinue([c], ROBLES_HIRE, ["10000004"]).proceed, true);
    assert.equal(decidePersonMatchContinue([c], ROBLES_HIRE, []).proceed, false);
  });

  test("an empty candidate grid is an unexpected page state → refuse", () => {
    assert.equal(decidePersonMatchContinue([], ROBLES_HIRE, []).proceed, false);
  });

  test("formatPersonMatchCandidate renders id, name, masked NID and DOB", () => {
    assert.equal(formatPersonMatchCandidate(ROBLES_CANDIDATES[0]), "10773675 Emily Robles (NID ***9035, DOB 10/8)");
    assert.equal(formatPersonMatchCandidate(SUN_CANDIDATES[7]), "10743545 Haowen Sun (NID ***????, DOB ?)");
  });
});

describe("classifySubmitSignals", () => {
  test("error banner wins over everything", () => {
    assert.equal(classifySubmitSignals(true, true, true), "error");
  });
  test("Person Match Found is checked before the generic OK marker", () => {
    assert.equal(classifySubmitSignals(false, true, true), "person-match");
  });
  test("confirmation OK alone → success", () => {
    assert.equal(classifySubmitSignals(false, false, true), "success");
  });
  test("nothing → pending", () => {
    assert.equal(classifySubmitSignals(false, false, false), "pending");
  });
});
