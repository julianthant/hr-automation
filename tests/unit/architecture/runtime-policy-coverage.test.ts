/**
 * Workflow runtime migration guards (Phase 6).
 *
 * - Every kernel workflow declares runtimePolicy on defineWorkflow.
 * - Every action descriptor in those policies uses valid kind/scope/source.
 * - Batch-view projections cannot target run ids outside opened batch members.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildProjectionFromQueueSurface } from "../../../src/domain/workflow-runtime/projection.js";
import {
  batchViewActionsWithinMembers,
  validateWorkflowRuntimePolicy,
} from "../../../src/domain/workflow-runtime/validate.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import type { TrackerQueueGroupSurface } from "../../../src/tracker/queue-surfaces.js";
import { getAll } from "../../../src/core/kernel/registry.js";

// Side-effect imports register every kernel workflow in the metadata registry.
import "../../../src/workflows/person-lookup/workflow.js";
import "../../../src/workflows/crm-doc-download/workflow.js";
import "../../../src/workflows/emergency-contact/workflow.js";
import "../../../src/workflows/i9-lookup/workflow.js";
import "../../../src/workflows/oath-signature/workflow.js";
import "../../../src/workflows/oath-upload/workflow.js";
import "../../../src/workflows/onbase/workflow.js";
import "../../../src/workflows/ocr/workflow.js";
import "../../../src/workflows/onboarding/workflow.js";
import "../../../src/workflows/old-kronos-reports/workflow.js";
import "../../../src/workflows/separations/workflow.js";
import "../../../src/workflows/sharepoint-download/workflow.js";
import "../../../src/workflows/work-study/workflow.js";

const WORKFLOWS_DIR = join(process.cwd(), "src/workflows");

function workflowDirs(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => {
    const full = join(WORKFLOWS_DIR, name);
    return statSync(full).isDirectory();
  });
}

for (const dir of workflowDirs()) {
  const workflowFile = join(WORKFLOWS_DIR, dir, "workflow.ts");
  let src: string;
  try {
    src = readFileSync(workflowFile, "utf8");
  } catch {
    continue;
  }

  if (!src.includes("defineWorkflow(")) continue;

  test(`${dir}/workflow.ts declares runtimePolicy in defineWorkflow`, () => {
    assert.ok(
      src.includes("runtimePolicy:"),
      `src/workflows/${dir}/workflow.ts calls defineWorkflow but does not declare 'runtimePolicy:'. ` +
        "Spread DEFAULT_WORKFLOW_RUNTIME_POLICY or export a workflow-specific policy constant.",
    );
  });
}

test("registered workflow metadata runtime policies validate action descriptors", () => {
  const errors: string[] = [];
  for (const meta of getAll()) {
    const policy = meta.runtimePolicy;
    assert.ok(
      policy,
      `workflow "${meta.name}" is registered without runtimePolicy metadata`,
    );
    errors.push(...validateWorkflowRuntimePolicy(policy, meta.name));
  }
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("batch-view visible actions stay scoped to opened batch member run ids", () => {
  const members = [
    {
      workflow: "person-lookup",
      id: "member-a",
      runId: "run-a",
      parentRunId: "batch-run",
      status: "failed",
      timestamp: "2026-05-20T12:00:00.000Z",
      data: { archetype: "operation-member" },
    },
    {
      workflow: "person-lookup",
      id: "member-b",
      runId: "run-b",
      parentRunId: "batch-run",
      status: "failed",
      timestamp: "2026-05-20T12:01:00.000Z",
      data: { archetype: "operation-member" },
    },
  ] as TrackerEntry[];

  const surface: TrackerQueueGroupSurface = {
    kind: "operation",
    parentRunId: "batch-run",
    parent: {
      workflow: "person-lookup",
      id: "batch-run",
      runId: "batch-run",
      status: "pending",
      timestamp: "2026-05-20T12:00:00.000Z",
      data: { archetype: "operation" },
    },
    members,
  };

  const projection = buildProjectionFromQueueSurface(surface, {});
  const scoped = {
    ...projection,
    actions: projection.actions.map((action) =>
      action.kind === "retry" || action.kind === "delete"
        ? {
            ...action,
            source: "batch-view" as const,
            scope: "visible-view" as const,
            targets: [{ workflowId: "person-lookup", id: "member-a", runId: "run-a" }],
          }
        : action,
    ),
  };

  assert.deepEqual(batchViewActionsWithinMembers(scoped, ["run-a", "run-b"]), []);

  const leaking = {
    ...scoped,
    actions: scoped.actions.map((action) =>
      action.kind === "retry"
        ? {
            ...action,
            targets: [
              { workflowId: "person-lookup", id: "member-a", runId: "run-a" },
              { workflowId: "person-lookup", id: "outside", runId: "outside-run" },
            ],
          }
        : action,
    ),
  };
  const errors = batchViewActionsWithinMembers(leaking, ["run-a", "run-b"]);
  assert.ok(errors.length > 0);
  assert.match(errors[0] ?? "", /outside-run/);
});
