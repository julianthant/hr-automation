/**
 * runI9CheckMember — person-match → optional hire-dated person-lookup →
 * roster rematch. Every IO seam stubbed.
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
import type { PersonLookupResult } from "../../../../src/workflows/person-lookup/outcome.js";

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
  const byPpsId = new Map<string, ActionHistoryRow[]>();
  for (const r of rows) {
    byEmplId.set(r.ucpathEmplId, [...(byEmplId.get(r.ucpathEmplId) ?? []), r]);
    const pps = r.ppsEid.replace(/^0+/, "") || "";
    if (pps) byPpsId.set(pps, [...(byPpsId.get(pps) ?? []), r]);
  }
  return {
    byEmplId,
    byNormalizedName: new Map(),
    byLastFirst: new Map(),
    byPpsId,
    sourcePath: "/x",
  };
}

function makeCtx() {
  const data: Record<string, unknown> = {};
  const steps: string[] = [];
  const skipped: string[] = [];
  const ctx = {
    page: async () => ({}) as never,
    step: async (name: string, fn: () => Promise<unknown>) => {
      steps.push(name);
      return fn();
    },
    skipStep: (name: string) => {
      skipped.push(name);
    },
    updateData: (patch: Record<string, unknown>) => Object.assign(data, patch),
    screenshot: async () => {},
  };
  return { ctx: ctx as never, data, steps, skipped };
}

function harness(over: {
  search?: { found: boolean; matches?: Array<{ emplId: string; firstName: string; lastName: string }> };
  lookupResults?: PersonLookupResult[];
  rows?: ActionHistoryRow[];
  appendImpl?: (path: string, row: I9CheckTrackerRow) => Promise<void>;
}) {
  const appended: I9CheckTrackerRow[] = [];
  let searchCalls = 0;
  let lookupCalls = 0;
  const deps = {
    searchImpl: async () => {
      searchCalls += 1;
      return over.search ?? { found: false };
    },
    lookupImpl: (async () => {
      lookupCalls += 1;
      const results = over.lookupResults ?? [];
      return {
        input: { kind: "by-name" as const, name: "x" },
        results,
        allAttempts: [],
        selection: {
          input: { kind: "by-name" as const, name: "x" },
          status: results.length === 0 ? ("not-found" as const) : ("resolved" as const),
          searchName: "x",
          selected: results[0] ?? null,
          results,
          candidateEids: results.map((r) => r.emplId),
        },
      };
    }) as never,
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
  return {
    deps: deps as never,
    appended,
    calls: () => ({ searchCalls, lookupCalls }),
  };
}

describe("runI9CheckMember", () => {
  it("person-match found → person-lookup skipped → EID roster rematch + tracker", async () => {
    const { ctx, data, steps, skipped } = makeCtx();
    const { deps, appended, calls } = harness({
      search: {
        found: true,
        matches: [{ emplId: "10411099", firstName: "Gabriel", lastName: "Sanchez" }],
      },
      rows: [rosterRow({})],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.deepEqual(steps, ["person-match", "roster-match"]);
    assert.deepEqual(skipped, ["person-lookup"]);
    assert.equal(calls().lookupCalls, 0);
    assert.equal(data.ucpathFound, "true");
    assert.equal(data.eid, "10411099");
    assert.equal(data.ppsEid, "728527");
    assert.equal(data.separationDate, "9/19/2021");
    assert.equal(data.section1Present, "Yes — page 9");
    assert.equal(data.section2Present, "Yes — page 1");
    assert.equal(data.personMatchFound, "true");

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

  it("person-match not-found → person-lookup hire-date hit → found + roster", async () => {
    const { ctx, data, steps, skipped } = makeCtx();
    const { deps, appended, calls } = harness({
      search: { found: false },
      lookupResults: [
        { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "04/25/2016" },
      ],
      rows: [rosterRow({})],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.deepEqual(steps, ["person-match", "person-lookup", "roster-match"]);
    assert.deepEqual(skipped, []);
    assert.equal(calls().searchCalls, 1);
    assert.equal(calls().lookupCalls, 1);
    assert.equal(data.personMatchFound, "false");
    assert.equal(data.ucpathFound, "true");
    assert.equal(data.eid, "10411099");
    assert.equal(appended[0].action, "Keep");
  });

  it("not found (match + lookup miss) → Shred row backed by OCR roster NAME-match seed", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      search: { found: false },
      lookupResults: [
        { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "01/01/2010" },
      ],
    });

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

  it("no SSN/DOB → person-match skipped as not-found → lookup path with hire-date", async () => {
    const { ctx, data, steps } = makeCtx();
    const { deps, appended, calls } = harness({
      lookupResults: [
        {
          emplId: "10462662",
          name: "Sawires, Marianne",
          startDate: "12/04/2018",
        },
      ],
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

    assert.deepEqual(steps, ["person-match", "person-lookup", "roster-match"]);
    assert.equal(calls().searchCalls, 0, "no identifiers → never call searchPerson");
    assert.equal(calls().lookupCalls, 1);
    assert.equal(data.personMatchFound, "false");
    assert.equal(data.ucpathFound, "true");
    assert.equal(data.section1Present, "Missing");
    assert.equal(appended[0].ucpathEmplId, "10462662");
    assert.equal(appended[0].separationDate, "4/19/2021");
    // 4/19/2021 + 5y = 4/19/2026 < 7/16/2026 → Shred.
    assert.equal(appended[0].action, "Shred");
  });

  it("lookup hire-date miss → not-found", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      search: { found: false },
      lookupResults: [
        { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "01/01/2010" },
      ],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.equal(data.ucpathFound, "false");
    assert.equal(appended[0].action, "Shred");
  });

  it("multiple ±7d hire-date hits → ambiguous (no chip / review note)", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      search: { found: false },
      lookupResults: [
        { emplId: "10000001", name: "Sanchez, A", startDate: "04/25/2016" },
        { emplId: "10000002", name: "Sanchez, B", startDate: "04/26/2016" },
      ],
    });

    await runI9CheckMember(ctx, input(), deps);

    assert.equal(data.ucpathFound, undefined, "ambiguous must not stamp a definitive chip");
    assert.equal(data.ucpathFoundLabel, "Ambiguous in UCPath (2 candidates)");
    assert.equal(appended[0].action, "");
    assert.match(appended[0].notes, /Multiple Person Org candidates match the I-9 hire date/);
  });

  it("missing hireDate on lookup path → ambiguous review (never shred from name alone)", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      lookupResults: [
        { emplId: "10462662", name: "Sawires, Marianne", startDate: "12/04/2018" },
      ],
    });

    await runI9CheckMember(
      ctx,
      input({
        person: {
          name: "Sawires, Marianne",
          section2Page: 3,
          orphanSection2: true,
          // no hireDate
        },
      }),
      deps,
    );

    assert.equal(data.ucpathFound, undefined);
    assert.equal(appended[0].action, "");
    assert.match(appended[0].notes, /hire date missing/);
  });

  it("found in UCPath but NOT on the roster → blank action + explanatory note", async () => {
    const { ctx, data } = makeCtx();
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
    // Detail grid always carries the keys (blank when nothing matched).
    assert.equal(data.ppsEid, "");
    assert.equal(data.separationDate, "");
  });

  it("found + EID miss keeps OCR PPS/sep seed on the grid and spreadsheet", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      search: {
        found: true,
        matches: [{ emplId: "10999999", firstName: "New", lastName: "Person" }],
      },
      rows: [],
    });

    await runI9CheckMember(
      ctx,
      input({
        roster: {
          ppsEid: "44696",
          ppsEidPadded: "000044696",
          separationDate: "10/16/2021",
        },
      }),
      deps,
    );

    assert.equal(data.ppsEid, "44696", "5-digit OCR PPS seed stays on the row");
    assert.equal(data.separationDate, "10/16/2021");
    assert.equal(appended[0].ppsEid, "000044696");
    assert.equal(appended[0].separationDate, "10/16/2021");
    // sep 10/16/2021 + 5y = 10/16/2026 > today 7/16/2026 → Keep
    assert.equal(appended[0].action, "Keep");
  });

  it("found + EID miss + OCR PPS seed rematches Action History by PPS", async () => {
    const { ctx, data } = makeCtx();
    const { deps, appended } = harness({
      search: {
        found: true,
        matches: [{ emplId: "10999999", firstName: "Gabriel", lastName: "Sanchez" }],
      },
      rows: [
        rosterRow({
          ucpathEmplId: "10411099",
          ppsEid: "000728527",
          jobEndDate: "9/19/2021",
        }),
      ],
    });

    await runI9CheckMember(
      ctx,
      input({
        roster: { ppsEid: "728527", ppsEidPadded: "000728527" },
      }),
      deps,
    );

    assert.equal(data.ppsEid, "728527");
    assert.equal(data.separationDate, "9/19/2021");
    assert.equal(appended[0].ppsEid, "000728527");
    assert.equal(appended[0].separationDate, "9/19/2021");
    assert.equal(appended[0].action, "Keep");
  });

  it("tracker append failure THROWS (member goes red; verdict already stamped)", async () => {
    const { ctx, data } = makeCtx();
    const { deps } = harness({
      search: { found: false },
      lookupResults: [],
      appendImpl: async () => {
        throw new Error("disk full");
      },
    });

    await assert.rejects(() => runI9CheckMember(ctx, input(), deps), /disk full/);
    assert.equal(data.ucpathFound, "false", "search result survives on the row");
  });
});
