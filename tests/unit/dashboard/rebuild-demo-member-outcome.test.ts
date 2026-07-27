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

test("every outcome is COLUMN-SIZED, and every one explains itself in a sentence", () => {
  for (const o of I9.memberOutcomes ?? []) {
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

test("the vocabulary is a WORKFLOW declaration, not an i9 special case", () => {
  // Exactly one workflow declares one today — which is the point: the surface
  // reads `workflow.memberOutcomes`, so the next workflow that needs outcomes
  // adds a descriptor field and no component changes.
  const declaring = DEMO_WORKFLOW_LIST.filter((w) => w.memberOutcomes);
  assert.deepEqual(
    declaring.map((w) => w.id),
    ["i9-check"],
  );
  // ...and every other workflow's members simply have no outcome, rather than
  // being handed a vocabulary that does not describe what they do.
  for (const w of DEMO_WORKFLOW_LIST) {
    if (w.id === "i9-check") continue;
    assert.equal(w.memberOutcomes, undefined, `${w.id} borrowed a vocabulary`);
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
  const members = orderedMemberIds("i9-batch").map((id) => DEMO_ROWS[id]);
  const outcomeWords = new Set(I9_VOCABULARY.flatMap((o) => o.label.toLowerCase().split(/\s+/)));

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
