import assert from "node:assert/strict";
import { test } from "vitest";

import {
  EXPLORER_GRAPHS,
  SEPARATIONS_GRAPH,
  contractTotals,
  dryRunPosture,
  explorerRunOptions,
  fieldKey,
  graphFor,
  lanesOf,
  laneOf,
  overlayForRun,
  provenanceOfRow,
  recordedBeyondContract,
  recordedForContractRow,
  skippedAboveBoundary,
  systemsOf,
  type ExplorerGraph,
  type OverlayRecorded,
} from "@/components/dev/rebuild-demo/demo-explorer-wire";
import { allTopLevelRows } from "@/components/dev/rebuild-demo/demo-archive-wire";
import { DEMO_WORKFLOWS, DEMO_WORKFLOW_LIST } from "@/components/dev/rebuild-demo/demo-wire";
import type { DemoRow } from "@/components/dev/rebuild-demo/demo-data";

/* =========================================================================
 * The registry is covered — the whole point of the pass
 * ====================================================================== */

test("every workflow the registry serves has a descriptor graph", () => {
  const missing = DEMO_WORKFLOW_LIST.filter((workflow) => !graphFor(workflow.id)).map((w) => w.id);
  assert.deepEqual(missing, []);
  assert.equal(EXPLORER_GRAPHS.length, DEMO_WORKFLOW_LIST.length);
});

test("a graph never invents a workflow the registry does not hold, and never duplicates one", () => {
  const seen = new Set<string>();
  for (const graph of EXPLORER_GRAPHS) {
    assert.ok(DEMO_WORKFLOWS[graph.workflowId], `${graph.workflowId} is not in the registry`);
    assert.equal(seen.has(graph.workflowId), false, `${graph.workflowId} is drawn twice`);
    seen.add(graph.workflowId);
  }
});

test("a graph's label and version are the registry's, so the page cannot drift from the rail", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const workflow = DEMO_WORKFLOWS[graph.workflowId];
    assert.equal(graph.label, workflow.label, `${graph.workflowId} label`);
    assert.equal(graph.version, workflow.version, `${graph.workflowId} major`);
    assert.equal(graph.minorVersion, workflow.minorVersion ?? 0, `${graph.workflowId} minor`);
  }
});

/* =========================================================================
 * Structural integrity — the renderer relies on all of it
 * ====================================================================== */

test("node ids are unique inside a graph, and an alias never shadows another node", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const ids = graph.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length, `${graph.workflowId} has a duplicate node id`);
    for (const node of graph.nodes) {
      for (const alias of node.aliases ?? []) {
        assert.equal(ids.includes(alias), false, `${graph.workflowId}: alias ${alias} shadows a node id`);
      }
    }
    const aliases = graph.nodes.flatMap((node) => node.aliases ?? []);
    assert.equal(new Set(aliases).size, aliases.length, `${graph.workflowId} reuses an alias`);
  }
});

test("every edge names nodes the graph actually has", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      assert.ok(ids.has(edge.from), `${graph.workflowId}: edge from ${edge.from} has no node`);
      assert.ok(ids.has(edge.to), `${graph.workflowId}: edge to ${edge.to} has no node`);
    }
  }
});

test("a lane's nodes are contiguous — the graph renders one divider per lane", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const seen: string[] = [];
    let previous: string | undefined;
    for (const node of graph.nodes) {
      const lane = laneOf(node);
      if (lane !== previous) {
        assert.equal(seen.includes(lane), false, `${graph.workflowId}: lane ${lane} is interrupted`);
        seen.push(lane);
        previous = lane;
      }
    }
    assert.deepEqual(lanesOf(graph), seen);
  }
});

test("a graph either has one implicit lane or names every lane it uses", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const lanes = lanesOf(graph);
    if (lanes.length === 1) continue;
    assert.equal(lanes.includes(""), false, `${graph.workflowId} mixes named lanes with an unnamed one`);
  }
});

/* =========================================================================
 * The dry-run posture — the fact the page must never infer from an absence
 * ====================================================================== */

test("a boundary names a real node, and that node is one a dry run skips", () => {
  for (const graph of EXPLORER_GRAPHS) {
    if (!graph.dryRunBoundaryNodeId) continue;
    const node = graph.nodes.find((n) => n.id === graph.dryRunBoundaryNodeId);
    assert.ok(node, `${graph.workflowId}: boundary names a node that does not exist`);
    assert.equal(node.skippedInDryRun, true, `${graph.workflowId}: the boundary node is not skipped by a dry run`);
  }
});

test("everything drawn below the boundary line is skipped by a dry run", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const boundary = graph.dryRunBoundaryNodeId;
    if (!boundary) {
      const skipped = graph.nodes.filter((node) => node.skippedInDryRun).map((node) => node.id);
      assert.deepEqual(skipped, [], `${graph.workflowId} skips nodes but draws no boundary`);
      continue;
    }
    const index = graph.nodes.findIndex((node) => node.id === boundary);
    graph.nodes.slice(index).forEach((node) => {
      assert.equal(node.skippedInDryRun, true, `${graph.workflowId}: ${node.id} sits below the line but is not skipped`);
    });
  }
});

test("the boundary lives in the LAST lane, so nothing unrelated renders below the dashed line", () => {
  for (const graph of EXPLORER_GRAPHS) {
    if (!graph.dryRunBoundaryNodeId) continue;
    const lanes = lanesOf(graph);
    const node = graph.nodes.find((n) => n.id === graph.dryRunBoundaryNodeId);
    assert.ok(node);
    assert.equal(laneOf(node), lanes[lanes.length - 1], `${graph.workflowId}: the boundary is not in the last lane`);
  }
});

test("a dry run skips a SET of nodes, not a suffix — the ones above the line are reported", () => {
  // Separations' Job summary fills the Kuali form, so a rehearsal skips it three
  // nodes before the boundary. The line alone would claim it runs.
  assert.deepEqual(skippedAboveBoundary(SEPARATIONS_GRAPH), ["Job summary"]);
  for (const graph of EXPLORER_GRAPHS) {
    const boundary = graph.dryRunBoundaryNodeId;
    const index = boundary ? graph.nodes.findIndex((node) => node.id === boundary) : graph.nodes.length;
    const expected = graph.nodes
      .slice(0, index)
      .filter((node) => node.skippedInDryRun)
      .map((node) => node.id);
    assert.deepEqual(skippedAboveBoundary(graph), boundary ? expected : []);
  }
});

test("the three postures are distinct, and each graph lands in exactly the right one", () => {
  const posture = Object.fromEntries(EXPLORER_GRAPHS.map((graph) => [graph.workflowId, dryRunPosture(graph)]));

  // A rehearsal that stops at a line.
  assert.equal(posture.separations, "boundary");
  assert.equal(posture.onboarding, "boundary");
  assert.equal(posture["oath-signature"], "boundary");
  assert.equal(posture["oath-upload"], "boundary");
  assert.equal(posture["emergency-contact"], "boundary");
  assert.equal(posture.onbase, "boundary");

  // Writes a system of record and honours NO rehearsal — the hazard case.
  assert.equal(posture["work-study"], "no-rehearsal");
  assert.equal(posture["kronos-pay-rule"], "no-rehearsal");

  // Changes no system of record, so there is nothing to stop short of.
  assert.equal(posture["person-lookup"], "no-system-write");
  assert.equal(posture["person-match"], "no-system-write");
  assert.equal(posture["i9-lookup"], "no-system-write");
  assert.equal(posture.ocr, "no-system-write");
  assert.equal(posture["i9-check"], "no-system-write");
  assert.equal(posture["crm-doc-download"], "no-system-write");
  assert.equal(posture["sharepoint-download"], "no-system-write");
  assert.equal(posture["old-kronos-reports"], "no-system-write");
});

test("a no-system-write graph holds no write node, and a no-rehearsal graph holds one", () => {
  for (const graph of EXPLORER_GRAPHS) {
    const hasWrite = graph.nodes.some((node) => node.kind === "write");
    const posture = dryRunPosture(graph);
    if (posture === "no-system-write") assert.equal(hasWrite, false, `${graph.workflowId} writes but claims it does not`);
    if (posture === "no-rehearsal") assert.equal(hasWrite, true, `${graph.workflowId} claims a write it does not have`);
  }
});

test("a write contract row always says how it is proved", () => {
  for (const graph of EXPLORER_GRAPHS) {
    for (const node of graph.nodes) {
      for (const row of node.contract) {
        if (row.dir !== "write") continue;
        assert.ok(row.proof, `${graph.workflowId}/${node.id}: write ${row.field} has no proof`);
      }
    }
  }
});

test("a delegation node names a workflow the registry holds", () => {
  for (const graph of EXPLORER_GRAPHS) {
    for (const node of graph.nodes) {
      if (!node.delegatesTo) continue;
      assert.ok(DEMO_WORKFLOWS[node.delegatesTo], `${graph.workflowId}/${node.id} delegates to nothing real`);
    }
  }
});

test("contract totals and systems are derived, never authored twice", () => {
  const totals = contractTotals(SEPARATIONS_GRAPH);
  const reads = SEPARATIONS_GRAPH.nodes.flatMap((n) => n.contract).filter((r) => r.dir === "read").length;
  const writes = SEPARATIONS_GRAPH.nodes.flatMap((n) => n.contract).filter((r) => r.dir === "write").length;
  assert.deepEqual(totals, { reads, writes, files: 0 });
  assert.deepEqual(systemsOf(SEPARATIONS_GRAPH), ["kuali", "ucpath", "kronos"]);
});

test("a file write is counted apart from a system write, so the header cannot contradict the chip", () => {
  // I-9 Check says "changes no system of record" AND appends a retention row.
  // Both are true; a single `writes` count would have made one of them read as
  // a lie in the panel header.
  const i9 = graphFor("i9-check") as ExplorerGraph;
  assert.equal(dryRunPosture(i9), "no-system-write");
  const totals = contractTotals(i9);
  assert.equal(totals.writes, 0);
  assert.equal(totals.files, 1);

  // Onboarding has both: two real system writes and the iDocs download.
  const onboarding = graphFor("onboarding") as ExplorerGraph;
  const onTotals = contractTotals(onboarding);
  assert.ok(onTotals.writes > 0);
  assert.equal(onTotals.files, 1);
});

test("no graph counts a system write while claiming it changes no system of record", () => {
  for (const graph of EXPLORER_GRAPHS) {
    if (dryRunPosture(graph) !== "no-system-write") continue;
    assert.equal(contractTotals(graph).writes, 0, `${graph.workflowId} contradicts its own posture`);
  }
});

/* =========================================================================
 * The overlay — derived, and never claiming an outcome it did not achieve
 * ====================================================================== */

function rowById(id: string): DemoRow {
  const row = allTopLevelRows().find((candidate) => candidate.id === id);
  assert.ok(row, `fixture ${id} is gone`);
  return row;
}

test("a live run's unrecorded node is NOT REACHED; an ended run's is OFF PATH", () => {
  const live = overlayForRun(SEPARATIONS_GRAPH, rowById("sep-nathan"));
  const finished = overlayForRun(SEPARATIONS_GRAPH, rowById("d2-sep-lena"));

  // A node the live run has NOT recorded at all — the multi-document lane, which
  // a single-document run never enters.
  const liveTail = live.nodes.find((n) => n.nodeId === "Parse typed input");
  assert.equal(liveTail?.state, "pending");
  assert.equal(liveTail?.skippedBecause, "not reached yet");
  assert.equal(live.inFlight, true);

  const endedOffPath = finished.nodes.find((n) => n.nodeId === "Job summary");
  assert.equal(endedOffPath?.state, "skipped");
  assert.equal(endedOffPath?.skippedBecause, "not on this run's path");
  assert.equal(finished.inFlight, false);
});

test("no node of any run's overlay is ever reported done without a recorded step", () => {
  for (const graph of EXPLORER_GRAPHS) {
    for (const option of explorerRunOptions(graph, allTopLevelRows())) {
      const overlay = overlayForRun(graph, option.row);
      for (const node of overlay.nodes) {
        if (node.state !== "done") continue;
        const descriptor = graph.nodes.find((n) => n.id === node.nodeId);
        assert.ok(descriptor);
        const labels = [descriptor.id, ...(descriptor.aliases ?? [])];
        const recordedStep = option.row.steps.some((step) => labels.includes(step.label));
        // A gate has no step of its own — its `done` comes from the row's gate.
        assert.ok(
          recordedStep || descriptor.kind === "gate",
          `${graph.workflowId}/${node.nodeId} claims done with nothing recorded`,
        );
      }
    }
  }
});

test("coverage never exceeds the graph, and the graph's own node count is the denominator", () => {
  for (const graph of EXPLORER_GRAPHS) {
    for (const option of explorerRunOptions(graph, allTopLevelRows())) {
      assert.equal(option.total, graph.nodes.length);
      assert.ok(option.reached <= option.total, `${graph.workflowId}/${option.row.id} over-counts`);
    }
  }
});

test("a waiting run stops on its gate, and the overlay names where it stopped", () => {
  const overlay = overlayForRun(SEPARATIONS_GRAPH, rowById("sep-maria"));
  const gate = overlay.nodes.find((n) => n.nodeId === "Identity approval");
  assert.equal(gate?.state, "waiting");
  assert.equal(overlay.stoppedAtNodeId, "Identity approval");
});

test("a gate the run RECORDED a step for reads that step, not the absent gate object", () => {
  // `oath-batch` walked its approval and closed it, so the row carries no gate
  // any more — inferring from that reported a step the run demonstrably ran as
  // "not on this run's path".
  const graph = graphFor("oath-signature") as ExplorerGraph;
  const overlay = overlayForRun(graph, rowById("oath-batch"));
  const gate = overlay.nodes.find((n) => n.nodeId === "Your review");
  assert.equal(gate?.state, "done");
  assert.equal(gate?.skippedBecause, undefined);

  // And a gate still parked shows waiting off its recorded step.
  const parked = overlayForRun(graphFor("ocr") as ExplorerGraph, rowById("ocr-summer"));
  assert.equal(parked.nodes.find((n) => n.nodeId === "Your review")?.state, "waiting");
});

test("a run with no gate skips the gate node rather than parking on it", () => {
  const overlay = overlayForRun(SEPARATIONS_GRAPH, rowById("d1-sep-victor"));
  const gate = overlay.nodes.find((n) => n.nodeId === "Identity approval");
  assert.equal(gate?.state, "skipped");
  assert.equal(gate?.skippedBecause, "no decision was needed on this run");
});

test("an alias joins a run whose step label the descriptor has since renamed", () => {
  const graph = graphFor("work-study") as ExplorerGraph;
  const overlay = overlayForRun(graph, rowById("d1-ws-tomas"));
  const node = overlay.nodes.find((n) => n.nodeId === "Transaction");
  assert.equal(node?.state, "done");
  assert.equal(node?.recorded.some((entry) => entry.field === "Award" && entry.dir === "write"), true);
});

/* =========================================================================
 * The contract ↔ ledger join — what makes the contract worth being the spine
 * ====================================================================== */

test("a contract row is answered by the value the run recorded for it", () => {
  const overlay = overlayForRun(SEPARATIONS_GRAPH, rowById("sep-maria"));
  const extraction = overlay.nodes.find((n) => n.nodeId === "Kuali extraction");
  assert.ok(extraction);
  const node = SEPARATIONS_GRAPH.nodes.find((n) => n.id === "Kuali extraction");
  assert.ok(node);

  const lastDay = node.contract.find((row) => row.field === "Last day worked");
  assert.ok(lastDay);
  assert.equal(recordedForContractRow(extraction.recorded, lastDay)?.value, "07/15/2026");

  // A contract row the run did not record has no value — it is never filled in
  // with a plausible one.
  const docNumber = node.contract.find((row) => row.field === "Document number");
  assert.ok(docNumber);
  assert.equal(recordedForContractRow(extraction.recorded, docNumber), undefined);
});

test("a staged or unconfirmed write is carried through to the row, never flattened to a value", () => {
  const staged = overlayForRun(SEPARATIONS_GRAPH, rowById("sep-maria"));
  const stagedWrite = staged.nodes
    .find((n) => n.nodeId === "UCPath transaction")
    ?.recorded.find((entry) => entry.field === "Separation date");
  assert.equal(stagedWrite?.staged, true);
  assert.equal(stagedWrite?.unconfirmed, undefined);

  const parked = overlayForRun(SEPARATIONS_GRAPH, rowById("sep-rosa"));
  const parkedWrite = parked.nodes
    .find((n) => n.nodeId === "UCPath transaction")
    ?.recorded.find((entry) => entry.field === "Separation date");
  assert.equal(parkedWrite?.unconfirmed, true);
});

test("the direction is part of the join — a read never answers a write row", () => {
  const recorded: OverlayRecorded[] = [{ dir: "read", field: "Award", value: "$2,400", system: "ucpath" }];
  assert.equal(
    recordedForContractRow(recorded, { dir: "write", field: "Award", system: "ucpath", proof: "x" }),
    undefined,
  );
  assert.equal(recordedForContractRow(recorded, { dir: "read", field: "Award", system: "ucpath" })?.value, "$2,400");
});

test("fieldKey folds case, punctuation and a trailing qualifier", () => {
  assert.equal(fieldKey("Contact name (input)"), fieldKey("Contact name"));
  assert.equal(fieldKey("Last day worked"), "lastdayworked");
  assert.equal(fieldKey("UCPath ID"), fieldKey("ucpath id"));
  assert.notEqual(fieldKey("Award"), fieldKey("Prior award"));
});

test("a recorded value the descriptor does not list is surfaced, never dropped", () => {
  const recorded: OverlayRecorded[] = [
    { dir: "read", field: "Award", value: "$2,400", system: "ucpath" },
    { dir: "read", field: "Surprise", value: "42", system: "ucpath" },
  ];
  const beyond = recordedBeyondContract(recorded, [{ dir: "read", field: "Award", system: "ucpath" }]);
  assert.deepEqual(
    beyond.map((entry) => entry.field),
    ["Surprise"],
  );
});

test("provenance marks the rows a retry replayed or the operator corrected", () => {
  const graph = graphFor("crm-doc-download") as ExplorerGraph;
  const overlay = overlayForRun(graph, rowById("cd-samuel"));
  assert.equal(overlay.provenance.replayed.includes("CRM authentication"), true);
  assert.equal(overlay.provenance.corrected.includes("Roster email"), true);

  const auth = graph.nodes.find((n) => n.id === "CRM auth");
  assert.ok(auth);
  assert.equal(provenanceOfRow(overlay.provenance, auth.contract[0]), "replayed");

  const search = graph.nodes.find((n) => n.id === "Search record");
  assert.ok(search);
  const rosterEmail = search.contract.find((row) => row.field === "Roster email");
  assert.ok(rosterEmail);
  assert.equal(provenanceOfRow(overlay.provenance, rosterEmail), "corrected");

  // A run that replayed nothing claims nothing.
  const clean = overlayForRun(SEPARATIONS_GRAPH, rowById("d1-sep-victor"));
  assert.deepEqual(clean.provenance.replayed, []);
  assert.deepEqual(clean.provenance.corrected, []);
});

/* =========================================================================
 * The run selector
 * ====================================================================== */

test("the run list is every stepped run of the workflow, most-covered first", () => {
  const options = explorerRunOptions(SEPARATIONS_GRAPH, allTopLevelRows());
  const ids = options.map((option) => option.row.id);
  assert.ok(ids.includes("sep-maria"));
  assert.ok(ids.includes("sep-list"), "a coordinator run is offered, not silently dropped");
  for (let i = 1; i < options.length; i += 1) {
    assert.ok(options[i - 1].reached >= options[i].reached, "options are not sorted by coverage");
  }
});

test("both shapes of a fan-out workflow lay over the one graph", () => {
  const options = explorerRunOptions(SEPARATIONS_GRAPH, allTopLevelRows());
  const coordinator = options.find((option) => option.row.id === "sep-list");
  assert.ok(coordinator);
  assert.equal(coordinator.offGraph, false, "the multi-document lane is part of the descriptor");

  const overlay = overlayForRun(SEPARATIONS_GRAPH, coordinator.row);
  assert.equal(overlay.nodes.find((n) => n.nodeId === "Parse typed input")?.state, "done");
  assert.equal(overlay.nodes.find((n) => n.nodeId === "Kuali extraction")?.state, "pending");
});

test("no run of any workflow lands off the graph entirely", () => {
  for (const graph of EXPLORER_GRAPHS) {
    for (const option of explorerRunOptions(graph, allTopLevelRows())) {
      assert.equal(
        option.offGraph,
        false,
        `${graph.workflowId}: ${option.row.id} recorded nothing the graph draws`,
      );
    }
  }
});

test("a QUEUED run is not off the graph — it has recorded every step and reached none", () => {
  const graph = graphFor("oath-signature") as ExplorerGraph;
  const queued = explorerRunOptions(graph, allTopLevelRows()).find((option) => option.row.id === "ou-s-4");
  assert.ok(queued);
  assert.equal(queued.reached, 0);
  assert.equal(queued.offGraph, false);
  const overlay = overlayForRun(graph, queued.row);
  assert.equal(overlay.matched, 3, "its three per-signer steps are recorded");
  assert.equal(overlay.nodes.find((n) => n.nodeId === "Sign oath")?.state, "pending");
});
