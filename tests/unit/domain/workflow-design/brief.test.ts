/**
 * Unit tests for `renderDesignBrief` — the generated `.md` a future session reads
 * first. It must be deterministic (re-generating after an edit = clean diff),
 * include every design-intent node, summarize the live config separately, and
 * flag under-specified custom nodes as open questions.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { renderDesignBrief } from "../../../../src/domain/workflow-design/brief.js";
import type { WorkflowDesignSpec } from "../../../../src/domain/workflow-design/types.js";

function spec(): WorkflowDesignSpec {
  return {
    schemaVersion: 1,
    workflow: "oath-signature",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: "Reshape the member rows into status chips.",
    nodes: [
      { id: "row", type: "row", position: { x: 0, y: 0 }, config: { title: { scheme: "pdf-filename" } } },
      {
        id: "custom-1",
        type: "custom",
        position: { x: 0, y: 100 },
        intent: { label: "Member chip", description: "compact chip per signer", look: "mono id, status dot" },
      },
      { id: "custom-2", type: "custom", position: { x: 0, y: 200 }, intent: { label: "Mystery widget" } },
      { id: "note-1", type: "note", position: { x: 0, y: 300 }, intent: { description: "keep the trace id visible" } },
    ],
    edges: [{ id: "e1", source: "row", target: "custom-1", type: "custom", label: "feeds" }],
  };
}

describe("renderDesignBrief", () => {
  test("is deterministic for the same spec", () => {
    assert.equal(renderDesignBrief(spec()), renderDesignBrief(spec()));
  });

  test("includes the header, live config, every intent node, constraints, open questions", () => {
    const md = renderDesignBrief(spec());
    assert.match(md, /# Workflow design intent — oath-signature/);
    assert.match(md, /2026-01-01T00:00:00\.000Z/);
    assert.match(md, /Reshape the member rows into status chips\./);

    // live config section names the overridden row
    assert.match(md, /## Live config applied/);
    assert.match(md, /Queue row.*pdf-filename/s);

    // every intent node appears
    assert.match(md, /Member chip/);
    assert.match(md, /compact chip per signer/);
    assert.match(md, /Mystery widget/);
    assert.match(md, /keep the trace id visible/);

    // a connection is described in prose
    assert.match(md, /Connections:/);

    // constraints block carried forward
    assert.match(md, /## Constraints/);
    assert.match(md, /lucide-react only/);

    // the description-less custom node is flagged
    assert.match(md, /## Open questions/);
    assert.match(md, /Mystery widget.*needs a spec/s);
  });

  test("empty spec renders the no-overrides + no-intent placeholders", () => {
    const md = renderDesignBrief({
      schemaVersion: 1,
      workflow: "demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [],
      edges: [],
    });
    assert.match(md, /No overrides/);
    assert.match(md, /No design-intent nodes drawn yet/);
    assert.match(md, /_None flagged._/);
  });

  test("action nodes render in a dedicated automation section — not in config or intent", () => {
    const md = renderDesignBrief({
      schemaVersion: 1,
      workflow: "separations",
      generatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        {
          id: "act-1",
          type: "action",
          position: { x: 0, y: 0 },
          action: {
            opId: "kuali.separationForm.eid#fill",
            kind: "fill",
            system: "kuali",
            label: "Fill EID",
            selectorFqn: "kuali.separationForm.eid",
            inputVar: "eid",
            note: "must be 8 digits",
          },
        },
        {
          id: "act-2",
          type: "action",
          position: { x: 0, y: 100 },
          action: {
            opId: "ucpath.jobSummary.name#scrape",
            kind: "scrape",
            system: "ucpath",
            label: "Scrape Name",
            role: "cell",
            accessibleName: "Employee Name",
            outputVar: "employeeName",
          },
        },
      ],
      edges: [],
    });

    // Dedicated automation section exists
    assert.match(md, /## Automation \(real operations\)/);
    // Kind + label rendered as heading
    assert.match(md, /### Fill EID _\(fill\)_/);
    assert.match(md, /### Scrape Name _\(scrape\)_/);
    // Selector for act-1
    assert.match(md, /kuali\.separationForm\.eid/);
    // Data flow
    assert.match(md, /Fills from.*eid/s);
    assert.match(md, /Scrapes into.*employeeName/s);
    // Note
    assert.match(md, /must be 8 digits/);
    // role + accessibleName for act-2
    assert.match(md, /role.*cell/s);
    assert.match(md, /Employee Name/);
    // System + op id
    assert.match(md, /kuali.*kuali\.separationForm\.eid#fill/s);

    // Action nodes must NOT appear in "Live config applied"
    const configSection = md.split("## Design intent")[0] ?? "";
    assert.doesNotMatch(configSection, /Fill EID/);

    // Action nodes must NOT appear in "Design intent to build"
    assert.match(md, /No design-intent nodes drawn yet/);
  });
});
