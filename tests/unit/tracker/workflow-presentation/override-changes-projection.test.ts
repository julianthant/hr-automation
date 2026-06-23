/**
 * Task 6.2 — override-changes-projection
 *
 * Positive complement to 6.1 (no-op parity): prove that a delegation-naming
 * OVERRIDE changes the projected member/prep title+subtitle end-to-end, and
 * reverts when the override is deleted.
 *
 * Flow: writeOverride → effectiveMetadata → buildWorkflowRunProjection
 *       → deleteOverride → effectiveMetadata → reverts to baseline.
 *
 * Two cases:
 *   - Member (oath-signature): overrides both memberTitle + memberSubtitle
 *   - Prep (ocr): overrides prepTitle only (subtitle unchanged)
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkflowRunProjection } from "../../../../src/domain/workflow-runtime/projection.js";
import { effectiveMetadata } from "../../../../src/tracker/workflow-presentation/effective.js";
import {
  writeOverride,
  deleteOverride,
} from "../../../../src/tracker/workflow-presentation/override-store.js";
import { getAll } from "../../../../src/core/kernel/registry.js";
import type { TrackerEntry } from "../../../../src/tracker/jsonl.js";

// Side-effect imports register every kernel workflow in the metadata registry.
import "../../../../src/workflows/person-lookup/workflow.js";
import "../../../../src/workflows/crm-doc-download/workflow.js";
import "../../../../src/workflows/emergency-contact/workflow.js";
import "../../../../src/workflows/i9-lookup/workflow.js";
import "../../../../src/workflows/oath-signature/workflow.js";
import "../../../../src/workflows/oath-upload/workflow.js";
import "../../../../src/workflows/ocr/workflow.js";
import "../../../../src/workflows/onboarding/workflow.js";
import "../../../../src/workflows/old-kronos-reports/workflow.js";
import "../../../../src/workflows/separations/workflow.js";
import "../../../../src/workflows/sharepoint-download/workflow.js";
import "../../../../src/workflows/work-study/workflow.js";

function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-05-20T12:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

describe("override-changes-projection (Task 6.2)", () => {
  describe("member case — oath-signature delegation naming", () => {
    it("write override → projection CHANGES; delete override → projection REVERTS to baseline", (t) => {
      const dir = mkdtempSync(join(tmpdir(), "wfpres-member-"));
      t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

      // Get base metadata from registry (populated by side-effect imports above)
      const all = getAll();
      const oathMeta = all.find((m) => m.name === "oath-signature");
      assert.ok(oathMeta, "oath-signature must be registered");

      // Build a delegated member entry (parentRunId set → member scope)
      const member = entry({
        workflow: "oath-signature",
        id: "signer-001",
        runId: "signer-run-001",
        parentRunId: "op-run-001",
        status: "running",
        data: {
          archetype: "single",
          queueRowKind: "person",
          name: "Doe, Jane",
          emplId: "10000001",
          __traceId: "os-120000-abcd",
        },
      });

      // ─── BASELINE (no override) ───────────────────────────────────────────
      const baseline = buildWorkflowRunProjection(member, {});
      assert.equal(baseline.title, "Doe, Jane", "baseline title = person name");
      assert.equal(baseline.subtitle, "10000001", "baseline subtitle = EID (eid-else-trace default)");

      // ─── WRITE OVERRIDE ───────────────────────────────────────────────────
      // memberTitle: custom-template exercises the template engine end-to-end
      // memberSubtitle: trace-only swaps the subtitle off EID
      // BOTH must be set or resolveMemberPresentation is a no-op (projection.ts:194)
      writeOverride(dir, "oath-signature", {
        presentation: {
          delegation: {
            memberTitle: { scheme: "custom-template", template: "{name} — Signer" },
            memberSubtitle: { scheme: "trace-only" },
          },
        },
      });

      // ─── effectiveMetadata reflects the override ──────────────────────────
      const eff = effectiveMetadata(oathMeta, dir);
      assert.deepEqual(
        eff.presentation?.delegation?.memberTitle,
        { scheme: "custom-template", template: "{name} — Signer" },
        "effectiveMetadata.presentation.delegation.memberTitle == override",
      );
      assert.deepEqual(
        eff.presentation?.delegation?.memberSubtitle,
        { scheme: "trace-only" },
        "effectiveMetadata.presentation.delegation.memberSubtitle == override",
      );

      // ─── PROJECTION CHANGES ───────────────────────────────────────────────
      const overridden = buildWorkflowRunProjection(member, {
        resolvePresentation: () => eff.presentation,
      });

      // Custom-template rendered: "{name} — Signer" with name="Doe, Jane"
      assert.equal(
        overridden.title,
        "Doe, Jane — Signer",
        "overridden title = template rendered",
      );
      // trace-only subtitle = the __traceId value
      assert.equal(
        overridden.subtitle,
        "os-120000-abcd",
        "overridden subtitle = trace id",
      );

      // Load-bearing change assertions: both must differ from baseline
      assert.notEqual(overridden.title, baseline.title, "title CHANGED from baseline");
      assert.notEqual(overridden.subtitle, baseline.subtitle, "subtitle CHANGED from baseline");

      // ─── DELETE OVERRIDE → REVERT ─────────────────────────────────────────
      const deleted = deleteOverride(dir, "oath-signature");
      assert.ok(deleted, "deleteOverride returned true (file existed)");

      const eff2 = effectiveMetadata(oathMeta, dir);
      const reverted = buildWorkflowRunProjection(member, {
        resolvePresentation: () => eff2.presentation,
      });

      assert.deepEqual(
        { title: reverted.title, subtitle: reverted.subtitle },
        { title: baseline.title, subtitle: baseline.subtitle },
        "reverted projection equals baseline",
      );
    });
  });

  describe("prep case — ocr delegation naming", () => {
    it("write prepTitle override → title CHANGES, subtitle unchanged; delete → title REVERTS", (t) => {
      const dir = mkdtempSync(join(tmpdir(), "wfpres-prep-"));
      t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

      const all = getAll();
      const ocrMeta = all.find((m) => m.name === "ocr");
      assert.ok(ocrMeta, "ocr must be registered");

      // Build an OCR prep entry (archetype:"preview", mode:"prepare").
      // queueRowKind:"file" is required so resolveQueueRowPresentation takes the
      // naming path (kind must be non-undefined for the custom-template to render).
      const prep = entry({
        workflow: "ocr",
        id: "ocr-prep-001",
        runId: "ocr-run-001",
        status: "running",
        step: "awaiting-approval",
        data: {
          archetype: "preview",
          queueRowKind: "file",
          mode: "prepare",
          formType: "oath",
          pdfOriginalName: "oath-batch.pdf",
          __traceId: "oc-130000-e1f2",
        },
      });

      // ─── BASELINE (no override) ───────────────────────────────────────────
      const baseline = buildWorkflowRunProjection(prep, {});
      assert.equal(baseline.title, "oath-batch.pdf", "baseline title = pdf filename");

      // ─── WRITE OVERRIDE ───────────────────────────────────────────────────
      // prepTitle: custom-template using {pdfOriginalName} (verified token in template.ts)
      writeOverride(dir, "ocr", {
        presentation: {
          delegation: {
            prepTitle: {
              scheme: "custom-template",
              template: "{pdfOriginalName} — Review",
            },
          },
        },
      });

      // ─── effectiveMetadata reflects the override ──────────────────────────
      const eff = effectiveMetadata(ocrMeta, dir);
      assert.deepEqual(
        eff.presentation?.delegation?.prepTitle,
        { scheme: "custom-template", template: "{pdfOriginalName} — Review" },
        "effectiveMetadata.presentation.delegation.prepTitle == override",
      );

      // ─── PROJECTION CHANGES (title only) ─────────────────────────────────
      const overridden = buildWorkflowRunProjection(prep, {
        resolvePresentation: () => eff.presentation,
      });

      // Template rendered: "{pdfOriginalName} — Review" → "oath-batch.pdf — Review"
      assert.equal(
        overridden.title,
        "oath-batch.pdf — Review",
        "overridden title = template rendered",
      );

      // subtitle is UNCHANGED — prepTitle is title-only (projection.ts:346-347)
      assert.equal(
        overridden.subtitle,
        baseline.subtitle,
        "overridden subtitle == baseline subtitle (prepTitle does not affect subtitle)",
      );

      // Load-bearing change assertion: title must differ
      assert.notEqual(overridden.title, baseline.title, "title CHANGED from baseline");

      // ─── DELETE OVERRIDE → REVERT ─────────────────────────────────────────
      const deleted = deleteOverride(dir, "ocr");
      assert.ok(deleted, "deleteOverride returned true (file existed)");

      const eff2 = effectiveMetadata(ocrMeta, dir);
      const reverted = buildWorkflowRunProjection(prep, {
        resolvePresentation: () => eff2.presentation,
      });

      assert.equal(reverted.title, baseline.title, "reverted title == baseline title");
    });
  });
});
