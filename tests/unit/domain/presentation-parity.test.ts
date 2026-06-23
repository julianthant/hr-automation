/**
 * Presentation parity regression test — task 6.1 of the Workflow Modifier feature.
 *
 * LOAD-BEARING PROOF: with NO explicit presentation override, the default naming
 * scheme from `defaultPresentationFromMetadata` renders BYTE-IDENTICAL to the
 * pre-feature legacy kind dispatch (`resolveQueueRowPresentation` without `naming`).
 *
 * Location: tests/unit/domain/ (next to the projection foundation it extends).
 * The spec said tests/scenarios/ — that directory does NOT exist; the projection-parity
 * foundation lives here and this test belongs beside it.
 *
 * Three dimensions:
 *   A — scheme-vs-legacy: default scheme deepEquals legacy kind dispatch on {title, subtitle}
 *   B — projection byte-identical under resolvePresentation (regression net for task 6.3)
 *   C — default presentation.steps is a no-op on applyStepDisplay
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { getAll } from "../../../src/core/kernel/registry.js";
import { resolveQueueRowPresentation } from "../../../src/domain/queue-row-presentation.js";
import { buildWorkflowRunProjection } from "../../../src/domain/workflow-runtime/projection.js";
import { applyStepDisplay, formatStepLabel } from "../../../src/domain/workflow-presentation/step-display.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

// Side-effect imports — register every kernel workflow in the metadata registry.
import "../../../src/workflows/person-lookup/workflow.js";
import "../../../src/workflows/crm-doc-download/workflow.js";
import "../../../src/workflows/emergency-contact/workflow.js";
import "../../../src/workflows/i9-lookup/workflow.js";
import "../../../src/workflows/oath-signature/workflow.js";
import "../../../src/workflows/oath-upload/workflow.js";
import "../../../src/workflows/ocr/workflow.js";
import "../../../src/workflows/onboarding/workflow.js";
import "../../../src/workflows/old-kronos-reports/workflow.js";
import "../../../src/workflows/separations/workflow.js";
import "../../../src/workflows/sharepoint-download/workflow.js";
import "../../../src/workflows/work-study/workflow.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Build a minimal TrackerEntry for the given workflow and kind. */
function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-06-23T10:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

/**
 * Build a representative TrackerEntry for the workflow's OWN kind (derived from
 * the default naming scheme's title scheme).
 *
 * Field mapping verified against resolveNaming / schemes.ts:
 *   person-name  → data.name, data.emplId, data.__traceId → person kind
 *   pdf-filename → data.pdfOriginalName, data.__traceId   → file kind
 *   catalog-label→ data.__queueTitle / data.__queueRootTitle, data.__traceId → catalog kind
 *
 * __queueTitle + __queueRootTitle are always populated (they feed readQueueTitle).
 */
function entryForScheme(
  workflowName: string,
  titleScheme: string,
  traceId: string,
): TrackerEntry {
  if (titleScheme === "person-name") {
    return entry({
      workflow: workflowName,
      id: `${workflowName}-person-001`,
      status: "running",
      data: {
        archetype: "single",
        queueRowKind: "person",
        name: "Doe, Jane",
        emplId: "20001234",
        __traceId: traceId,
        __queueTitle: "Doe, Jane",
        __queueRootTitle: "Doe, Jane",
      },
    });
  }
  if (titleScheme === "pdf-filename") {
    return entry({
      workflow: workflowName,
      id: `${workflowName}-file-001`,
      status: "running",
      data: {
        archetype: "preview",
        queueRowKind: "file",
        pdfOriginalName: "document.pdf",
        __traceId: traceId,
        __queueTitle: "document.pdf",
        __queueRootTitle: "document.pdf",
      },
    });
  }
  // catalog-label
  return entry({
    workflow: workflowName,
    id: `${workflowName}-catalog-001`,
    status: "running",
    data: {
      archetype: "single",
      queueRowKind: "catalog",
      label: "Sharepoint Roster",
      __traceId: traceId,
      __queueTitle: "Sharepoint Roster",
      __queueRootTitle: "Sharepoint Roster",
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Dimension A — scheme defaults reproduce legacy kind dispatch
//
// For each registered workflow, the default scheme (meta.presentation.naming)
// must produce byte-identical {title, subtitle} to the legacy kind dispatch
// (resolveQueueRowPresentation without naming option).
//
// Verified against resolveNaming / schemes.ts — see entryForScheme() above.
// If a workflow's default scheme produces a DIFFERENT title/subtitle than
// legacy kind dispatch, this assertion will FAIL intentionally — that is the
// entire point (a defaultPresentationFromMetadata bug for task 6.3 to fix).
// ────────────────────────────────────────────────────────────────────────────

describe("Dimension A — default scheme == legacy kind dispatch", () => {
  it("scheme vs legacy: flat (preferTraceIdSubtitle:false) — all workflows", () => {
    const workflows = getAll();
    assert.ok(workflows.length >= 12, `Expected >= 12 workflows, got ${workflows.length}`);

    for (const meta of workflows) {
      const naming = meta.presentation.naming;
      assert.ok(naming, `${meta.name}: presentation.naming must be present after registry normalization`);
      const titleScheme = naming.title?.scheme ?? "person-name";
      const traceId = `${meta.code}-100000-ab12`;
      const e = entryForScheme(meta.name, titleScheme, traceId);

      const legacy = resolveQueueRowPresentation(e, { preferTraceIdSubtitle: false });
      const scheme = resolveQueueRowPresentation(e, { naming, preferTraceIdSubtitle: false });

      assert.ok(legacy != null, `${meta.name}: legacy presentation must resolve (entry has queueRowKind)`);
      assert.ok(scheme != null, `${meta.name}: scheme presentation must resolve`);

      assert.deepStrictEqual(
        { title: scheme.title, subtitle: scheme.subtitle },
        { title: legacy.title, subtitle: legacy.subtitle },
        `${meta.name} (${titleScheme}): default scheme must produce byte-identical title/subtitle to legacy kind dispatch`,
      );
    }
  });

  it("scheme vs legacy: preferTraceIdSubtitle:true — person-kind workflows", () => {
    const personWorkflows = getAll().filter(
      (m) => (m.presentation.naming?.title?.scheme ?? "person-name") === "person-name",
    );
    assert.ok(personWorkflows.length >= 1, "Expected at least one person-kind workflow");

    for (const meta of personWorkflows) {
      const naming = meta.presentation.naming!;
      const traceId = `${meta.code}-110000-cd34`;
      const e = entryForScheme(meta.name, "person-name", traceId);

      const legacy = resolveQueueRowPresentation(e, { preferTraceIdSubtitle: true });
      const scheme = resolveQueueRowPresentation(e, { naming, preferTraceIdSubtitle: true });

      assert.ok(legacy != null, `${meta.name}: legacy person presentation must resolve`);
      assert.ok(scheme != null, `${meta.name}: scheme person presentation must resolve`);

      assert.deepStrictEqual(
        { title: scheme.title, subtitle: scheme.subtitle },
        { title: legacy.title, subtitle: legacy.subtitle },
        `${meta.name} (person-name, preferTraceId): default scheme must be byte-identical to legacy`,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dimension B — buildWorkflowRunProjection byte-identical with/without
//              resolvePresentation (REGRESSION NET for task 6.3)
//
// Today this passes trivially: top-level naming is NOT yet wired through
// resolvePresentation (that is task 6.3's job), and member/prep rows whose
// default presentation has no `delegation` block return undefined from
// resolveMemberPresentation / resolvePrepPresentation.
//
// INTENTIONAL TAUTOLOGY — do NOT delete this block thinking it's useless.
// When task 6.3 wires top-level naming through resolvePresentation, this test
// will start genuinely exercising the default-naming round-trip and will catch
// any drift between the wired path and the no-resolver path.
// ────────────────────────────────────────────────────────────────────────────

describe("Dimension B — projection byte-identical with/without resolvePresentation (regression net for task 6.3)", () => {
  it("buildWorkflowRunProjection title/subtitle unchanged by default resolvePresentation — all entry types", () => {
    const allMeta = getAll();
    assert.ok(allMeta.length >= 12, `Expected >= 12 workflows, got ${allMeta.length}`);
    const byName = new Map(allMeta.map((m) => [m.name, m]));

    for (const meta of allMeta) {
      const naming = meta.presentation.naming;
      const titleScheme = naming?.title?.scheme ?? "person-name";
      const traceId = `${meta.code}-120000-ef56`;

      // Battery of representative entries:
      // 1. own-kind entry (person / file / catalog)
      const ownEntry = entryForScheme(meta.name, titleScheme, traceId);

      // 2. delegated member row (parentRunId set, person kind)
      const memberEntry = entry({
        workflow: meta.name,
        id: `${meta.name}-member-001`,
        parentRunId: "parent-run-001",
        status: "pending",
        data: {
          archetype: "single",
          queueRowKind: "person",
          name: "Smith, John",
          emplId: "30001234",
          __traceId: traceId,
          __queueTitle: "Smith, John",
          __queueRootTitle: "Smith, John",
        },
      });

      // 3. OCR prep row (preview shape + mode:prepare + pdfOriginalName)
      const prepEntry = entry({
        workflow: meta.name,
        id: `${meta.name}-prep-001`,
        status: "running",
        data: {
          archetype: "preview",
          mode: "prepare",
          queueRowKind: "file",
          pdfOriginalName: "ocr-batch.pdf",
          __traceId: traceId,
          __queueTitle: "ocr-batch.pdf",
          __queueRootTitle: "ocr-batch.pdf",
        },
      });

      for (const [label, e] of [
        ["own-kind", ownEntry],
        ["member", memberEntry],
        ["prep", prepEntry],
      ] as const) {
        const withoutResolver = buildWorkflowRunProjection(e, {});
        const withDefaultResolver = buildWorkflowRunProjection(e, {
          resolvePresentation: (id) => byName.get(id)?.presentation,
        });

        assert.deepStrictEqual(
          { title: withDefaultResolver.title, subtitle: withDefaultResolver.subtitle },
          { title: withoutResolver.title, subtitle: withoutResolver.subtitle },
          `${meta.name} [${label}]: projection must be byte-identical with/without default resolvePresentation`,
        );
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dimension C — default presentation.steps is a no-op on applyStepDisplay
//
// No workflow declares presentation.steps today, so meta.presentation.steps
// is undefined. applyStepDisplay with undefined config must equal the call
// without config. This is a no-op contract, not a meaningful feature assertion —
// it pins the guarantee that steps need no migration.
// ────────────────────────────────────────────────────────────────────────────

describe("Dimension C — default presentation.steps is a no-op on applyStepDisplay", () => {
  it("applyStepDisplay with meta.presentation.steps deepEquals undefined config — all workflows", () => {
    const workflows = getAll();
    assert.ok(workflows.length >= 12, `Expected >= 12 workflows, got ${workflows.length}`);

    for (const meta of workflows) {
      const withConfig = applyStepDisplay([...meta.steps], meta.presentation.steps, formatStepLabel);
      const withoutConfig = applyStepDisplay([...meta.steps], undefined, formatStepLabel);

      assert.deepStrictEqual(
        withConfig,
        withoutConfig,
        `${meta.name}: applyStepDisplay with default presentation.steps must equal no-config call`,
      );
    }
  });
});
