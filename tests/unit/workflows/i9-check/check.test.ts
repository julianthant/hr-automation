/**
 * runI9CheckMember — the i9-check workflow step, with every IO seam
 * stubbed: UCPath search, name-only lookup, roster index, tracker append.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { runI9CheckMember } from "../../../../src/workflows/i9-check/check.js";
import type { I9CheckMemberInput } from "../../../../src/workflows/i9-check/schema.js";
import type {
  ActionHistoryIndex,
  ActionHistoryRow,
} from "../../../../src/services/matching/employee-action-history.js";
import type { I9CheckTrackerRow } from "../../../../src/tracker/exports/i9-check-tracker.js";

const TODAY = new Date(2026, 6, 16);

function input(over: Partial<I9CheckMemberInput> = {}): I9CheckMemberInput {
  return {
    mode: "i9-check",
    person: {
      name: "Sanchez, Gabriel",
      lastName: "Sanchez",
      firstName: "Gabriel",
      ssn: "558937070",
      dob: "10/08/1986",
      hireDate: "04/25/2016",
      sourcePage: 9,
      section2Page: 1,
    },
    ocrSessionId: "sess-1",
    ocrRunId: "run-1",
    recordIndex: 0,
    ...over,
  };
}

function rosterRow(over: Partial<ActionHistoryRow>): ActionHistoryRow {
  return {
    name: "Sanchez, Gabriel",
    ucpathEmplId: "10411099",
    ppsEid: "000728527",
    jobStartDate: "10/12/2018",
    jobEndDate: "9/19/2021",
    jobActionCode: "TER",
    jobAction: "Termination",
    ...over,
  };
}

function indexWith(rows: ActionHistoryRow[]): ActionHistoryIndex {
  const byEmplId = new Map<string, ActionHistoryRow[]>();
  for (const r of rows) {
    byEmplId.set(r.ucpathEmplId, [...(byEmplId.get(r.ucpathEmplId) ?? []), r]);
  }
  return { byEmplId, byNormalizedName: new Map(), byLastFirst: new Map(), sourcePath: "/x" };
}

function makeCtx() {
  const data: Record<string, unknown> = {};
  const steps: string[] = [];
  const ctx = {
    page: async () => ({}) as never,
    step: async (name: string, fn: () => Promise<unknown>) => {
      steps.push(name);
      return fn();
    },
    updateData: (patch: Record<string, unknown>) => Object.assign(data, patch),
    screenshot: async () => {},
  };
  return { ctx: ctx as never, data, steps };
}

function harness(over: {
  search?: { found: boolean; matches?: Array<{ emplId: string; firstName: string; lastName: string }> };
  lookupSelection?: {
    status: "resolved" | "not-found" | "ambiguous";
    selected?: { emplId: string; name: string } | null;
    candidateEids?: string[];
  };
  rows?: ActionHistoryRow[];
  appendImpl?: (path: string, row: I9CheckTrackerRow) => Promise<void>;
}) {
  const appended: I9CheckTrackerRow[] = [];
  const deps = {
    searchImpl: async () => over.search ?? { found: false },
    lookupImpl: (async () => ({
      input: { kind: "by-name", name: "x" },
      results: [],
      allAttempts: [],
      selection: {
        input: { kind: "by-name", name: "x" },
        status: over.lookupSelection?.status ?? "not-found",
        searchName: "x",
        selected: over.lookupSelection?.selected ?? null,
        results: [],
        candidateEids: over.lookupSelection?.candidateEids ?? [],
      },
    })) as never,
    loadRosterImpl: async () => indexWith(over.rows ?? []),
    appendRowImpl:
      over.appendImpl
      ?? (async (_path: string, row: I9CheckTrackerRow) => {
        appended.push(row);
      }),
    trackerPath: "/tmp/i9-tracker-test.xlsx",
    reviewerName: "Julian",
    today: TODAY,
  };
  return { deps: deps as never, appended };
}

describe("runI9CheckMember", () => {
  it("found → EID roster re-match → verdict stamped + tracker row appended (padded PPS)", async () => {
    const { ctx, data, steps } = makeCtx();
    const { deps, appended } = harness({
      search: {
        found: true,
        matches: [{ emplId: "10411099", firstName: "Gabriel", lastName: "Sanchez" }],
      },
      rows: [rosterRow({})],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.deepEqual(steps, ["i9-check"]);
    assert.equal(data.ucpathFound, "true");
    assert.equal(data.eid, "10411099");
    assert.equal(data.ppsEid, "728527");
    assert.equal(data.separationDate, "9/19/2021");
    assert.equal(data.section1Present, "Yes — page 9");
    assert.equal(data.section2Present, "Yes — page 1");

    assert.equal(appended.length, 1);
    const row = appended[0];
    assert.equal(row.employeeName, "Sanchez, Gabriel");
    assert.equal(row.ppsEid, "000728527", "spreadsheet gets the PADDED PPS ID");
    assert.equal(row.ucpathEmplId, "10411099");
    assert.equal(row.hireDate, "04/25/2016");
    assert.equal(row.separationDate, "9/19/2021");
    assert.equal(row.foundInUcpath, "Yes");
    // sep 9/19/2021 + 5y = 9/19/2026 > today (7/16/2026) → Keep + shred note.
    assert.equal(row.action, "Keep");
    assert.equal(row.notes, "Shred on 9/20/2026");
    assert.equal(row.reviewerName, "Julian");
  });

  it("not found → Shred row backed by the OCR-stage roster NAME-match seed", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({ search: { found: false } });

    await runI9CheckMember(
      ctx,
      input({
        roster: { ppsEid: "740026", ppsEidPadded: "000740026", separationDate: "" },
      }),
      deps,
    );

    assert.equal(data.ucpathFound, "false");
    assert.equal(appended[0].foundInUcpath, "Not found in UCPath");
    assert.equal(appended[0].action, "Shred");
    assert.equal(appended[0].ppsEid, "000740026", "not-found keeps the name-match seed");
    assert.equal(appended[0].ucpathEmplId, "");
  });

  it("name-only person (orphan Section 2) uses the Person Org lookup path", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      lookupSelection: {
        status: "resolved",
        selected: { emplId: "10462662", name: "Sawires, Marianne" },
      },
      rows: [
        rosterRow({
          name: "Sawires, Marianne",
          ucpathEmplId: "10462662",
          ppsEid: "000776924",
          jobEndDate: "4/19/2021",
        }),
      ],
    });

    await runI9CheckMember(
      ctx,
      input({
        person: {
          name: "Sawires, Marianne",
          hireDate: "12/04/2018",
          section2Page: 3,
          orphanSection2: true,
        },
      }),
      deps,
    );

    assert.equal(data.ucpathFound, "true");
    assert.equal(data.section1Present, "Missing");
    assert.equal(appended[0].ucpathEmplId, "10462662");
    assert.equal(appended[0].separationDate, "4/19/2021");
    // 4/19/2021 + 5y = 4/19/2026 < 7/16/2026 → Shred.
    assert.equal(appended[0].action, "Shred");
  });

  it("ambiguous name lookup → NO ucpathFound stamp, blank action, review note", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      lookupSelection: { status: "ambiguous", candidateEids: ["10000001", "10000002"] },
    });

    await runI9CheckMember(
      ctx,
      input({ person: { name: "Sanchez, Maria", orphanSection2: true, section2Page: 2 } }),
      deps,
    );

    assert.equal(data.ucpathFound, undefined, "ambiguous must not stamp a definitive chip");
    assert.equal(data.ucpathFoundLabel, "Ambiguous in UCPath (2 candidates)");
    assert.equal(appended[0].action, "");
    assert.match(appended[0].notes, /review manually/);
  });

  it("found in UCPath but NOT on the roster → blank action + explanatory note", async () => {
    const { ctx } = makeCtx();
    const { deps, appended } = harness({
      search: {
        found: true,
        matches: [{ emplId: "10999999", firstName: "New", lastName: "Person" }],
      },
      rows: [],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.equal(appended[0].action, "");
    assert.match(appended[0].notes, /not on the Action History roster/);
    assert.match(appended[0].notes, /EID 10999999/);
  });

  it("tracker append failure THROWS (member goes red; verdict already stamped)", async () => {
    const { ctx, data } = makeCtx();
    const { deps } = harness({
      search: { found: false },
      appendImpl: async () => {
        throw new Error("disk full");
      },
    });

    await assert.rejects(() => runI9CheckMember(ctx, input(), deps), /disk full/);
    assert.equal(data.ucpathFound, "false", "search result survives on the row");
  });
});
