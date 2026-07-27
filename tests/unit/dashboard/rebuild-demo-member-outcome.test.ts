import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_WORKFLOWS,
  DEMO_WORKFLOW_LIST,
  resolveMemberOutcome,
  type MemberOutcomeSpec,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";
import { DEMO_ROWS, orderedMemberIds } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * A member's STATUS answers "did it run"; its OUTCOME answers "what did it
 * find". They are orthogonal — the whole reason the outcome exists is that a
 * member is routinely `Verified done` with the outcome `Not found`, and the old
 * free-text detail column crammed both axes plus the evidence into one string
 * that truncated to `S1 + S2 · ret…`.
 *
 * These pin the four properties that keep it honest: the vocabulary is
 * DECLARED per workflow (never inferred from a workflow id), it is COLUMN-SIZED
 * (a word, not a sentence), an undeclared key FAILS LOUD rather than rendering
 * a blank cell forty rows down a scroll well, and a member that has not
 * finished looking carries NO outcome at all.
 */

const I9 = DEMO_WORKFLOWS["i9-check"];
const PL = DEMO_WORKFLOWS["person-lookup"];

/** the vocabulary, verbatim — a rename is a deliberate act, not a drift */
const I9_VOCABULARY: { key: string; label: string; tone: MemberOutcomeSpec["tone"] }[] = [
  { key: "found", label: "Found", tone: "quiet" },
  { key: "not-found", label: "Not found", tone: "danger" },
  { key: "unsure", label: "Unsure", tone: "warn" },
  { key: "incomplete", label: "Incomplete", tone: "warn" },
  { key: "not-searchable", label: "Not searchable", tone: "quiet" },
];

test("I-9 Check declares its member-outcome vocabulary, in the operator's words", () => {
  assert.deepEqual(
    (I9.memberOutcomes ?? []).map((o) => ({ key: o.key, label: o.label, tone: o.tone })),
    I9_VOCABULARY,
  );
});

/**
 * Person Lookup's vocabulary, verbatim.
 *
 * The operator, pointing at `resolved 10510…` in the detail column beside the
 * very same EID rendered in full in the next one: *"found or resolved is enough.
 * no need id after just to have it in the next column."* — and on the truncated
 * `found · INACTI…`: an inactive employee deserves its own key, not a qualifier
 * hung off the successful one.
 */
const PL_VOCABULARY: { key: string; label: string; tone: MemberOutcomeSpec["tone"] }[] = [
  { key: "resolved", label: "Resolved", tone: "quiet" },
  { key: "separated", label: "Separated", tone: "warn" },
  { key: "not-found", label: "Not found", tone: "danger" },
];

test("Person Lookup declares its member-outcome vocabulary, and `separated` is its own answer", () => {
  assert.deepEqual(
    (PL.memberOutcomes ?? []).map((o) => ({ key: o.key, label: o.label, tone: o.tone })),
    PL_VOCABULARY,
  );
  // The load-bearing one: `Separated` is a KEY, not `Resolved` with a footnote.
  // UCPath found the person; what it reports is that they no longer work here,
  // which is a different answer and the one that blocks work downstream.
  const separated = PL.memberOutcomes?.find((o) => o.key === "separated");
  assert.ok(separated);
  assert.equal(separated.label.split(" ").length, 1, "the inactive answer must be ONE word — it lives in a 104px column");
  assert.notEqual(separated.tone, "quiet", "an answer that blocks the packet may not be the quietest thing on the row");
});

test("no outcome label carries an id, a number or an ellipsis", () => {
  // The whole defect was an outcome column spending itself on the EID that has
  // its own column. A label is a WORD.
  for (const w of DEMO_WORKFLOW_LIST) {
    for (const o of w.memberOutcomes ?? []) {
      assert.ok(!/\d/.test(o.label), `${w.id}/${o.key} puts a number in the outcome column: ${o.label}`);
      assert.ok(!o.label.includes("…"), `${w.id}/${o.key} is already truncated in the fixture: ${o.label}`);
    }
  }
});

test("every outcome is COLUMN-SIZED, and every one explains itself in a sentence", () => {
  for (const o of [...(I9.memberOutcomes ?? []), ...(PL.memberOutcomes ?? [])]) {
    // Two words at most: the column is a fixed width so the names and the EIDs
    // beside it can line up, and a phrase that has to truncate defeats the
    // change it was made for.
    assert.ok(o.label.split(" ").length <= 2, `"${o.label}" is too long for a column`);
    assert.ok(o.label.length <= 16, `"${o.label}" is too long for a column`);
    // The word is the differentiator, so it must not repeat a status label.
    assert.ok(o.meaning.trim().length > 40, `${o.key} does not explain itself: ${o.meaning}`);
    assert.ok(o.meaning.trim().endsWith("."), `${o.key}'s meaning is not a sentence: ${o.meaning}`);
  }
});

test("the vocabulary is a WORKFLOW declaration, never a per-workflow special case", () => {
  // TWO workflows declare one now, and that is the proof the mechanism is a
  // mechanism: person-lookup got its outcomes by adding a descriptor field, and
  // not one component changed. The surface reads `workflow.memberOutcomes`.
  const declaring = DEMO_WORKFLOW_LIST.filter((w) => w.memberOutcomes);
  assert.deepEqual(
    declaring.map((w) => w.id),
    ["person-lookup", "i9-check"],
  );
  // The two vocabularies are DISJOINT where they should be: each names what its
  // own workflow can conclude, so neither is a generic set the other borrowed.
  const i9Keys = new Set((I9.memberOutcomes ?? []).map((o) => o.key));
  const plKeys = new Set((PL.memberOutcomes ?? []).map((o) => o.key));
  assert.ok(plKeys.has("separated") && !i9Keys.has("separated"));
  assert.ok(i9Keys.has("not-searchable") && !plKeys.has("not-searchable"));
  // ...and every workflow that declares none simply has none, rather than being
  // handed a vocabulary that does not describe what it does.
  for (const w of DEMO_WORKFLOW_LIST) {
    if (w.id === "i9-check" || w.id === "person-lookup") continue;
    assert.equal(w.memberOutcomes, undefined, `${w.id} borrowed a vocabulary`);
  }
});

test("a person-lookup member answers with ONE word, and the EID stays in the EID column", () => {
  const members = [...orderedMemberIds("pl-summer"), ...orderedMemberIds("pl-verify")].map((id) => DEMO_ROWS[id]);
  assert.ok(members.length > 5, "the person-lookup fixtures shrank — this test needs their spread");

  const seen = new Set<string>();
  for (const m of members) {
    assert.ok(m.memberOutcomeSpec, `${m.id} is a finished lookup with no outcome`);
    seen.add(m.memberOutcomeSpec.key);
    // The defect, pinned: the detail column may not repeat the EID that has its
    // own column one cell to the right.
    if (m.eid && m.memberFact) {
      assert.ok(!m.memberFact.includes(m.eid), `${m.id}'s detail repeats its own EID: ${m.memberFact}`);
    }
  }
  // Both answers the corpus actually contains are exercised. `not-found` is
  // declared without a member fixture on purpose — see the vocabulary's own
  // comment in `demo-wire.ts`: it is demonstrably an answer this workflow gives
  // (`pl-dana` ended with zero UCPath matches), and a vocabulary pruned to
  // whatever today's fixtures hold is one that throws the first time a real
  // member answers it.
  assert.deepEqual([...seen].sort(), ["resolved", "separated"]);
});

test("every outcome key the CORPUS uses is one its own workflow declared", () => {
  // The converse of "every declared outcome is exercised" — and the one that is
  // actually load-bearing, because `resolveMemberOutcome` fails loud at
  // assembly rather than rendering a blank cell forty rows down a scroll well.
  for (const row of Object.values(DEMO_ROWS)) {
    if (!row.memberOutcomeSpec) continue;
    const declared = (row.workflow.memberOutcomes ?? []).map((o) => o.key);
    assert.ok(
      declared.includes(row.memberOutcomeSpec.key),
      `${row.id} answers "${row.memberOutcomeSpec.key}", which ${row.workflow.id} does not declare`,
    );
  }
});

test("an outcome key the workflow never declared FAILS LOUD", () => {
  assert.throws(
    () => resolveMemberOutcome(I9, "probably-fine"),
    /declares no member outcome "probably-fine"/,
    "an undeclared key must throw, not render as an empty cell",
  );
  assert.throws(
    () => resolveMemberOutcome(DEMO_WORKFLOWS["emergency-contact"], "found"),
    /declares no member outcome "found"/,
    "a workflow with no vocabulary must refuse a key, not borrow i9's",
  );
});

test("outcome and status are ORTHOGONAL on the real corpus", () => {
  const members = orderedMemberIds("i9-batch").map((id) => DEMO_ROWS[id]);
  assert.ok(members.length > 40, "the i9 roster fixture shrank — this test needs its spread");

  const byOutcome = new Map<string, Set<string>>();
  for (const m of members) {
    if (!m.memberOutcomeSpec) continue;
    const statuses = byOutcome.get(m.memberOutcomeSpec.key) ?? new Set<string>();
    statuses.add(m.status);
    byOutcome.set(m.memberOutcomeSpec.key, statuses);
  }

  // Every declared outcome is exercised by the corpus, so none of them is a
  // word nobody has ever seen rendered.
  assert.deepEqual([...byOutcome.keys()].sort(), I9_VOCABULARY.map((o) => o.key).sort());

  // The load-bearing case: a member that RAN successfully and found nothing.
  const notFound = members.filter((m) => m.memberOutcomeSpec?.key === "not-found");
  assert.ok(notFound.length > 0);
  // ...and one that is `doneWarnings` (a real completion) yet `incomplete`.
  const incomplete = members.filter((m) => m.memberOutcomeSpec?.key === "incomplete");
  assert.ok(incomplete.every((m) => m.status === "doneWarnings"));
});

test("a member that has not finished looking carries NO outcome", () => {
  const members = orderedMemberIds("i9-batch").map((id) => DEMO_ROWS[id]);
  const unfinished = members.filter((m) => m.status === "running" || m.status === "queued");
  assert.ok(unfinished.length > 0, "the fixture no longer holds a live member");
  for (const m of unfinished) {
    assert.equal(
      m.memberOutcomeSpec,
      undefined,
      `${m.id} is ${m.status} but claims it found "${m.memberOutcomeSpec?.label}"`,
    );
  }
});

test("where a vocabulary exists, the detail column carries DETAIL — never a second telling of the outcome", () => {
  const members = [...orderedMemberIds("i9-batch"), ...orderedMemberIds("pl-summer"), ...orderedMemberIds("pl-verify")].map(
    (id) => DEMO_ROWS[id],
  );
  const outcomeWords = new Set(
    [...I9_VOCABULARY, ...PL_VOCABULARY].flatMap((o) => o.label.toLowerCase().split(/\s+/)),
  );

  for (const m of members) {
    if (!m.memberOutcomeSpec || !m.memberFact) continue;
    // A detail that restates the outcome spends the column twice and is exactly
    // how `S1 + S2 · retain 3y` came to be — two axes and the evidence crammed
    // into one string, in a fixed 104px cell, one click from the queue that
    // already said `Found`. The outcome word is the queue's; the detail's job
    // is the one fact the word cannot carry (which page, which roster row, how
    // many candidates, how long to retain).
    assert.notEqual(
      m.memberFact.toLowerCase(),
      m.memberOutcomeSpec.label.toLowerCase(),
      `${m.id} repeats its own outcome in the detail column`,
    );
    for (const word of m.memberFact.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 4) continue;
      assert.ok(
        !outcomeWords.has(word),
        `${m.id}'s detail "${m.memberFact}" borrows the outcome word "${word}" — say the other fact instead`,
      );
    }
  }
});

test("a workflow with no vocabulary keeps its members' free-text detail", () => {
  const members = orderedMemberIds("ec-packet").map((id) => DEMO_ROWS[id]);
  assert.ok(members.length > 0);
  for (const m of members) {
    assert.equal(m.memberOutcomeSpec, undefined);
    assert.ok(m.memberFact, `${m.id} has neither an outcome nor a detail — its column would be blank`);
  }
});
