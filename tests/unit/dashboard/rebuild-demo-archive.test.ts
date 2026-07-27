import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ARCHIVE_BULK_COUNT,
  ARCHIVE_RETENTION_NOTE,
  DEMO_ARCHIVE,
  EMPTY_ARCHIVE_QUERY,
  ARCHIVE_SORT_LABEL,
  archiveQueryIsFiltered,
  flattenArchiveTable,
  groupArchiveByBump,
  allTopLevelRows,
  archivedCapture,
  archivedRunTouchedTest,
  changeRecordFor,
  deriveBumpPlan,
  deriveRelaunchPlan,
  deriveVersionRegistry,
  exportArchivedRunJson,
  queryArchive,
  relaunchFromArchive,
  resetRelaunchSequence,
  submitVersionBump,
  type ArchiveQuery,
  type ArchiveSortKey,
} from "@/components/dev/rebuild-demo/demo-archive-wire";
import { fmtClock, type DemoWorkflowId } from "@/components/dev/rebuild-demo/demo-wire";

const q = (patch: Partial<ArchiveQuery>): ArchiveQuery => ({ ...EMPTY_ARCHIVE_QUERY, ...patch });

const run = (runId: string) => {
  const found = DEMO_ARCHIVE.find((r) => r.runId === runId);
  assert.ok(found, `${runId} is not in the archive`);
  return found;
};

// ---------------------------------------------------------------------------
// Finding something — the reason anyone opens an archive
// ---------------------------------------------------------------------------

test("search finds a person by name, by EID, by trace id and by confirmation number", () => {
  assert.deepEqual(
    queryArchive(DEMO_ARCHIVE, q({ text: "noor" })).map((r) => r.runId),
    ["arch-ec-noor-v3"],
  );
  assert.deepEqual(
    queryArchive(DEMO_ARCHIVE, q({ text: "10511903" })).map((r) => r.runId),
    ["arch-ec-derek-v3"],
  );
  assert.deepEqual(
    queryArchive(DEMO_ARCHIVE, q({ text: "se-101204-b6f0" })).map((r) => r.runId),
    ["arch-sep-imani-app2"],
  );
  assert.deepEqual(
    queryArchive(DEMO_ARCHIVE, q({ text: "INC0448120" })).map((r) => r.runId),
    ["arch-ou-spring-app2"],
  );
});

test("search reaches a MEMBER of a run, which is the only way to answer “did we file for this person”", () => {
  // The receipt says "13 of 14 updated · 1 not found". The other thirteen used
  // to be unrecoverable, so this is the assertion that the snapshot is genuinely
  // self-contained rather than merely summarised.
  const byMember = queryArchive(DEMO_ARCHIVE, q({ text: "Keiko Tanaka" }));
  assert.deepEqual(byMember.map((r) => r.runId), ["arch-ws-cohort-app2"]);
  assert.deepEqual(queryArchive(DEMO_ARCHIVE, q({ text: "10559002" })).map((r) => r.runId), ["arch-ws-cohort-app2"]);
});

test("a search that matches nothing returns nothing rather than everything", () => {
  assert.deepEqual(queryArchive(DEMO_ARCHIVE, q({ text: "zzzz-no-such-person" })), []);
});

test("filters narrow by workflow, outcome and instance", () => {
  // Property, not a count: the corpus now holds what a few version bumps
  // actually leave behind, so pinning a literal here would only pin the
  // fixture's size.
  const ec = queryArchive(DEMO_ARCHIVE, q({ workflowId: "emergency-contact" }));
  assert.ok(ec.length > 0);
  assert.ok(ec.every((r) => r.workflowId === "emergency-contact"));
  assert.ok(ec.length < DEMO_ARCHIVE.length, "the workflow filter narrowed nothing");

  const failed = queryArchive(DEMO_ARCHIVE, q({ status: "failed" }));
  assert.ok(failed.every((r) => r.finalStatus === "failed"));
  assert.ok(
    failed.some((r) => r.runId === "arch-onb-kai-app2"),
    "the authored failure is the one with a full failure record — it must survive every filter change",
  );

  const test = queryArchive(DEMO_ARCHIVE, q({ instance: "test" }));
  assert.ok(test.length > 0, "the archive must hold a run that touched a test instance");
  assert.ok(test.every(archivedRunTouchedTest));
  const prod = queryArchive(DEMO_ARCHIVE, q({ instance: "prod" }));
  assert.ok(prod.every((r) => !archivedRunTouchedTest(r)));
  assert.equal(test.length + prod.length, DEMO_ARCHIVE.length);
});

// ---------------------------------------------------------------------------
// AT SCALE — the property the whole table redesign rests on
// ---------------------------------------------------------------------------

test("the archive holds a REAL number of runs, in ONE corpus", () => {
  // Eight rows is what an archive looks like on its first day, and eight rows
  // fit however badly you draw them. The generated runs live in the SAME array
  // every other surface reads — the report's ledger and the version registry
  // included — so there is no second archive for them to disagree with.
  assert.ok(DEMO_ARCHIVE.length > 800, `the archive is only ${DEMO_ARCHIVE.length} rows — it proves nothing about scale`);
  assert.equal(DEMO_ARCHIVE.length, ARCHIVE_BULK_COUNT + 8);
  // Ids are unique, or the virtualiser's keys collide and rows swap under the
  // pointer while scrolling.
  assert.equal(new Set(DEMO_ARCHIVE.map((r) => r.runId)).size, DEMO_ARCHIVE.length);
  assert.equal(new Set(DEMO_ARCHIVE.map((r) => r.traceId)).size, DEMO_ARCHIVE.length);
});

test("the generated runs keep the authored ones the interesting ones", () => {
  const generated = DEMO_ARCHIVE.filter((r) => r.runId.startsWith("arch-bulk-"));
  assert.equal(generated.length, ARCHIVE_BULK_COUNT);
  // Three constraints, so 800 synthetic rows cannot bury the cases the demo
  // exists to show.
  assert.ok(generated.every((r) => r.evidence.length === 0), "a generated run carries evidence — it would bury the purged pointer");
  assert.ok(generated.every((r) => changeRecordFor(r.bumpId) !== undefined), "a generated run has no change record — that gap is authored, and is exactly one");
  assert.ok(
    generated.every((r) => r.durationLabel !== "51m 4s"),
    "a generated run matches the authored longest — the duration sort would stop being verifiable",
  );
});

// ---------------------------------------------------------------------------
// The table's own seams: column sorts, sections, and the flat window list
// ---------------------------------------------------------------------------

test("every sortable column is a column the table shows, and every sort is total", () => {
  const keys = Object.keys(ARCHIVE_SORT_LABEL) as ArchiveSortKey[];
  assert.deepEqual(keys, ["status", "name", "trace", "workflow", "when", "duration"]);
  for (const key of keys) {
    for (const dir of ["asc", "desc"] as const) {
      const sorted = queryArchive(DEMO_ARCHIVE, q({ sort: key, dir }));
      assert.equal(sorted.length, DEMO_ARCHIVE.length, `${key}/${dir} dropped or duplicated a run`);
      assert.equal(new Set(sorted.map((r) => r.runId)).size, DEMO_ARCHIVE.length);
    }
  }
});

test("a sort is STABLE — equal rows keep one order across renders", () => {
  // 800 rows over a six-value column means most comparisons are ties. Without a
  // tiebreak the tied rows reshuffle on every re-sort and the row the operator
  // is reading moves under the pointer.
  const a = queryArchive(DEMO_ARCHIVE, q({ sort: "status", dir: "asc" })).map((r) => r.runId);
  const b = queryArchive(DEMO_ARCHIVE, q({ sort: "status", dir: "asc" })).map((r) => r.runId);
  assert.deepEqual(a, b);
});

test("reversing the direction reverses the list exactly", () => {
  for (const key of ["name", "duration", "when"] as ArchiveSortKey[]) {
    const asc = queryArchive(DEMO_ARCHIVE, q({ sort: key, dir: "asc" })).map((r) => r.runId);
    const desc = queryArchive(DEMO_ARCHIVE, q({ sort: key, dir: "desc" })).map((r) => r.runId);
    assert.deepEqual([...asc].reverse(), desc, `${key} is not symmetric between its two directions`);
  }
});

test("the duration column really sorts by duration — the 51m cohort is the longest", () => {
  const longest = queryArchive(DEMO_ARCHIVE, q({ sort: "duration", dir: "desc" }));
  assert.equal(longest[0].runId, "arch-ws-cohort-app2");
});

test("grouping is applied AFTER the sort, and keeps every run exactly once", () => {
  const rows = queryArchive(DEMO_ARCHIVE, q({ sort: "name", dir: "asc" }));
  const sections = groupArchiveByBump(rows);
  assert.ok(sections.length > 1, "the corpus has only one bump — the sections prove nothing");
  assert.equal(sections.reduce((n, s) => n + s.runs.length, 0), rows.length);
  assert.equal(new Set(sections.map((s) => s.bumpId)).size, sections.length);
  // The chosen order survives INSIDE each section, which is what makes the two
  // controls independent.
  for (const section of sections) {
    const names = section.runs.map((r) => r.displayName ?? r.title);
    assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y)), `${section.bumpId} lost the sort`);
  }
});

test("a collapsed section contributes its header and NOTHING else", () => {
  const sections = groupArchiveByBump(queryArchive(DEMO_ARCHIVE, q({})));
  const open = flattenArchiveTable(sections, new Set());
  assert.equal(open.filter((i) => i.kind === "section").length, sections.length);
  assert.equal(open.filter((i) => i.kind === "run").length, DEMO_ARCHIVE.length);

  const first = sections[0];
  const partly = flattenArchiveTable(sections, new Set([first.bumpId]));
  assert.equal(partly.filter((i) => i.kind === "section").length, sections.length, "a collapsed section lost its header");
  assert.equal(partly.filter((i) => i.kind === "run").length, DEMO_ARCHIVE.length - first.runs.length);

  const shut = flattenArchiveTable(sections, new Set(sections.map((s) => s.bumpId)));
  assert.equal(shut.length, sections.length, "collapsing everything must cost one item per section, whatever the corpus size");
});

test("the empty state can tell a filtered miss from an empty archive", () => {
  assert.equal(archiveQueryIsFiltered(EMPTY_ARCHIVE_QUERY), false);
  assert.equal(archiveQueryIsFiltered(q({ text: "noor" })), true);
  assert.equal(archiveQueryIsFiltered(q({ instance: "test" })), true);
  // A sort is not a filter: changing the order must never make the empty state
  // offer to "clear the search".
  assert.equal(archiveQueryIsFiltered(q({ sort: "duration", dir: "asc" })), false);
});

test("a filter that excludes the selected run leaves a list the selection can land inside", () => {
  // The page resolves its selection against the VISIBLE list, so the property
  // that matters is that filtering never yields a list whose first element is
  // the excluded run.
  const visible = queryArchive(DEMO_ARCHIVE, q({ workflowId: "onboarding" }));
  assert.ok(visible.length > 0);
  assert.equal(visible.some((r) => r.runId === DEMO_ARCHIVE[0].runId), false);
});

// ---------------------------------------------------------------------------
// A snapshot is self-contained, and says how long it lives
// ---------------------------------------------------------------------------

test("every archived run carries the whole record, not a summary of it", () => {
  for (const r of DEMO_ARCHIVE) {
    assert.ok(r.steps.length > 0, `${r.runId} has no step timeline`);
    assert.ok(r.logs.length > 0, `${r.runId} has no log stream`);
    assert.ok(r.attempts.length > 0, `${r.runId} has no attempt history`);
    assert.ok(r.retention.policy.length > 0, `${r.runId} does not say how long it lives`);
    assert.ok(r.provenance.snapshotHash.startsWith("sha256:"), `${r.runId} has no integrity hash`);
    assert.ok(r.provenance.archivedBy.length > 0, `${r.runId} does not say who archived it`);
    assert.equal(typeof r.dryRun, "boolean", `${r.runId} cannot be told apart from a rehearsal`);
    assert.ok(r.enqueuedAt && r.endedAt && r.workflowCode, `${r.runId} is missing a stored identity field`);
  }
  assert.ok(ARCHIVE_RETENTION_NOTE.length > 40);
});

test("a failed run carries its failure record, and a clean run does not invent one", () => {
  assert.ok(run("arch-onb-kai-app2").failure, "a failed run with no failure record cannot be diagnosed");
  assert.match(run("arch-onb-kai-app2").failure!.writeState, /Nothing was written/);
  assert.equal(run("arch-ec-derek-v3").failure, undefined);
});

test("an evidence pointer says whether the bytes survived, and never invents an image", () => {
  const purged = DEMO_ARCHIVE.flatMap((r) => r.evidence).filter((e) => e.retention === "purged");
  assert.ok(purged.length > 0, "the archive must show at least one purged pointer");
  for (const item of DEMO_ARCHIVE.flatMap((r) => r.evidence)) {
    assert.ok(item.ref.startsWith("sha256:"), "an evidence pointer is content-addressed");
    assert.ok(item.retentionAt.length > 0, "a pointer with no retention state is a link you cannot tell from a dead one");
  }
  // A demo INSTANT, never a formatted clock: the viewer parses it with
  // `fmtClock`, which throws on anything else — a fixture holding "8:14 AM"
  // crashed the lightbox and only booting it caught that.
  for (const item of DEMO_ARCHIVE.flatMap((r) => r.evidence)) {
    if (item.capturedAt) assert.doesNotThrow(() => fmtClock(item.capturedAt!), `${item.id} stores a display clock, not an instant`);
  }
  const capture = archivedCapture(purged[0]);
  assert.equal(capture.kind, purged[0].kind);
  assert.match(capture.note ?? "", /The image itself is gone/);
});

test("an archived run exports as JSON that round-trips", () => {
  const parsed = JSON.parse(exportArchivedRunJson(run("arch-ws-cohort-app2")));
  assert.equal(parsed.runId, "arch-ws-cohort-app2");
  assert.equal(parsed.members.length, 14);
});

test("a run swept by a bump with no change record is a NAMED gap, not a raw id", () => {
  const orphan = DEMO_ARCHIVE.find((r) => !changeRecordFor(r.bumpId));
  assert.ok(orphan, "the archive must exercise the missing-change-record case");
  assert.equal(changeRecordFor(orphan.bumpId), undefined);
  // Every OTHER run resolves, so the gap is a real case rather than the norm.
  assert.equal(DEMO_ARCHIVE.filter((r) => !changeRecordFor(r.bumpId)).length, 1);
});

// ---------------------------------------------------------------------------
// Relaunch — it previews, it names the duplicate-write risk, it links the run
// ---------------------------------------------------------------------------

test("the relaunch plan names what the archived run already filed", () => {
  const plan = deriveRelaunchPlan(run("arch-ec-noor-v3"));
  assert.equal(plan.alreadyFiled.length, 1);
  assert.equal(plan.alreadyFiled[0].confirmation, "UCP-2026-0722-44119");
  // The duplicate-write risk is rendered LOUD from `alreadyFiled`; the caution
  // list deliberately does not restate it.
  assert.equal(plan.cautions.some((c) => /second time/.test(c)), false);
  assert.equal(plan.versionTag, "v4.0");
  assert.equal(plan.archivedVersionTag, "v3.1");
});

test("a dry run and a test-instance run each get their own caution", () => {
  const plan = deriveRelaunchPlan(run("arch-pl-legacy"));
  assert.ok(plan.cautions.some((c) => /DRY RUN/.test(c)));
  assert.ok(plan.cautions.some((c) => /TEST instance/.test(c)));
  assert.equal(plan.alreadyFiled.length, 0);
});

test("a relaunch returns the run it created, so the surface can link to it", () => {
  resetRelaunchSequence();
  const result = relaunchFromArchive(run("arch-ec-tomas-v3"));
  assert.equal(result.state, "applied");
  assert.equal(result.created.workflowId, "emergency-contact");
  assert.equal(result.created.panel, "Emergency Contact");
  assert.match(result.created.traceId, /^ec-relaunch-01$/);
  assert.match(result.detail, /not a resume/);
});

// ---------------------------------------------------------------------------
// The two bump arms
// ---------------------------------------------------------------------------

const rows = allTopLevelRows();

/** a workflow with a non-terminal run — the case a MAJOR bump has to refuse */
function blockedWorkflow(): DemoWorkflowId {
  const entry = deriveVersionRegistry(rows).find((e) => e.nonTerminal > 0);
  assert.ok(entry, "the corpus must hold a non-terminal run for the blocker arm to be reachable");
  return entry.workflowId;
}

test("a MAJOR bump archives the terminal runs and is refused by the non-terminal ones", () => {
  const id = blockedWorkflow();
  const plan = deriveBumpPlan("workflow", [id], rows, "major");
  assert.ok(plan.blockers.length > 0);
  assert.deepEqual(plan.unaffected, [], "a major bump lists non-terminal runs as blockers, not as unaffected");

  const refusal = submitVersionBump(plan, { what: "x", why: "y" });
  assert.equal(refusal.state, "rejected");
  assert.equal(refusal.code, "non-terminal-runs-outstanding");
  assert.match(refusal.detail, /NOTHING was bumped/);
});

test("a MINOR bump archives nothing, has no blockers, and says the in-flight runs carry on", () => {
  const id = blockedWorkflow();
  const plan = deriveBumpPlan("workflow", [id], rows, "minor");
  assert.deepEqual(plan.archivable, [], "a minor bump may never archive a run");
  assert.deepEqual(plan.blockers, [], "a minor bump has nothing to block it");
  assert.ok(plan.unaffected.length > 0, "the runs a major bump would have blocked are named as unaffected");

  const applied = submitVersionBump(plan, { what: "renamed a label", why: "presentation only" });
  assert.equal(applied.state, "applied");
  assert.match(applied.headline, /nothing was archived/i);
  assert.match(applied.detail, /MINOR bump/);
});

test("only the MAJOR arm moves the major digit", () => {
  const major = deriveBumpPlan("workflow", ["separations"], rows, "major");
  const minor = deriveBumpPlan("workflow", ["separations"], rows, "minor");
  assert.equal(major.targets[0].from, "v7.2");
  assert.equal(major.targets[0].to, "v8.0");
  assert.equal(minor.targets[0].from, "v7.2");
  assert.equal(minor.targets[0].to, "v7.3");
});

test("both arms still demand a change record — the archive's sweeps must be auditable", () => {
  // A workflow with nothing in flight, so the blocker refusal (which correctly
  // comes first) does not mask the change-record one.
  const clean = deriveVersionRegistry(rows).find((e) => e.nonTerminal === 0);
  assert.ok(clean, "the corpus must hold a workflow with nothing in flight");
  for (const kind of ["major", "minor"] as const) {
    const plan = deriveBumpPlan("workflow", [clean.workflowId], rows, kind);
    const result = submitVersionBump(plan, { what: "", why: "" });
    assert.equal(result.state, "rejected", `${kind} accepted an empty change record`);
    assert.equal(result.code, "change-record-incomplete");
  }
});

test("the registry keys on the MAJOR digit — a minor difference is not a prior version", () => {
  const separations = deriveVersionRegistry(rows).find((e) => e.workflowId === "separations");
  assert.ok(separations);
  assert.equal(separations.currentVersion, "7.2");
  assert.equal(separations.currentMajor, 7);
});
