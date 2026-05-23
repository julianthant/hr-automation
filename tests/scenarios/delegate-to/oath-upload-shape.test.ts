/**
 * Contract 3 scenario test — oath-upload-style end-to-end shape.
 *
 * Parent (synthetic, modeled on oath-upload's handler shape): delegates
 * to a synthetic OCR-like child via `ctx.delegateTo(child, ..., { renderAs:
 * "preview" })`, then "fans out" to N synthetic oath-signature-like
 * children via `ctx.delegateToAll(child, ..., { renderAs: "batch" })`,
 * then completes.
 *
 * This is intentionally a synthetic stand-in for the real oath-upload →
 * OCR → oath-signature chain — the production chain crosses workflow
 * folders (oath-upload-handler + ocr-orchestrator + oath-signature-daemon)
 * and the scenario harness only runs ONE workflow's runOneItem, so a
 * faithful end-to-end scenario would require harness changes outside the
 * scope of Contract 3. The shape we lock here is what the dashboard reads
 * off tracker JSONL: parent row + nested child rows with correct
 * archetype, parentRunId, and pristine input — the same invariants the
 * production oath-upload chain emits.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";

interface TrackerLine {
  workflow: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: string;
  step?: string;
  data?: Record<string, unknown>;
  input?: unknown;
}

function readWorkflowLines(trackerDir: string, workflow: string): TrackerLine[] {
  const file = join(trackerDir, `${workflow}-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

describe("oath-upload-shape scenario via ctx.delegateTo / ctx.delegateToAll", () => {
  test("parent → preview child → N batch children: every row carries parentRunId + correct archetype", async (t) => {
    const trackerDir = mkdtempSync(join(tmpdir(), "delegate-shape-"));
    t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

    // Synthetic "OCR" child — delegating-batch shape (single approval
    // preview row).
    const ocrLikeChild = defineWorkflow({
      name: "scen-ocr-like",
      archetype: "delegating-batch",
      systems: [],
      authSteps: false,
      steps: ["prep"] as const,
      schema: z.object({ sessionId: z.string() }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ sessionId: input.sessionId });
        await ctx.step("prep", async () => {});
      },
    });

    // Synthetic "oath-signature" child — single per-EID workflow.
    const sigLikeChild = defineWorkflow({
      name: "scen-sig-like",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["transaction"] as const,
      schema: z.object({ emplId: z.string() }),
      detailFields: [{ key: "emplId", label: "EID" }],
      getName: (d) => d.emplId ?? "",
      getId: (d) => d.emplId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ emplId: input.emplId });
        await ctx.step("transaction", async () => {});
      },
    });

    // Synthetic "oath-upload" parent — delegating-batch root that fans out
    // to OCR (preview) then signatures (batch).
    const parent = defineWorkflow({
      name: "scen-oath-upload-like",
      archetype: "delegating-batch",
      systems: [],
      authSteps: false,
      steps: ["delegate-ocr", "delegate-signatures"] as const,
      schema: z.object({ sessionId: z.string(), eids: z.array(z.string()) }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        await ctx.step("delegate-ocr", async () => {
          const result = await ctx.delegateTo(ocrLikeChild, { sessionId: input.sessionId }, {
            renderAs: "preview",
            itemId: input.sessionId,
          });
          if (result.status !== "done") throw new Error("OCR delegation did not complete");
        });
        await ctx.step("delegate-signatures", async () => {
          await ctx.delegateToAll(
            sigLikeChild,
            input.eids.map((emplId) => ({ emplId })),
            { renderAs: "batch" },
          );
        });
      },
    });

    await runWorkflow(parent, { sessionId: "sess-abc", eids: ["E1", "E2", "E3"] }, { trackerDir });

    // Parent row — batch-parent.
    const parentLines = readWorkflowLines(trackerDir, "scen-oath-upload-like");
    const parentPending = parentLines.find((l) => l.status === "pending");
    const parentDone = parentLines.find((l) => l.status === "done");
    expect((parentPending?.data as { archetype?: string }).archetype).toBe("batch-parent");
    expect(parentDone).toBeDefined();
    expect(parentDone?.parentRunId).toBeUndefined();

    const parentRunId = parentPending?.runId;
    expect(parentRunId).toBeDefined();

    // OCR child — delegate-child, preview override.
    const ocrLines = readWorkflowLines(trackerDir, "scen-ocr-like");
    const ocrPending = ocrLines.find((l) => l.status === "pending");
    expect(ocrPending).toBeDefined();
    expect(ocrPending?.parentRunId).toBe(parentRunId);
    expect((ocrPending?.data as { archetype?: string }).archetype).toBe("delegate-child");
    expect(ocrPending?.input).toEqual({ sessionId: "sess-abc" });
    expect(ocrPending?.id).toBe("sess-abc");

    // Signature children — delegate-child via renderAs: "batch", one per
    // EID, each carries parentRunId.
    const sigLines = readWorkflowLines(trackerDir, "scen-sig-like");
    const sigPendings = sigLines.filter((l) => l.status === "pending");
    expect(sigPendings.length).toBe(3);
    for (const p of sigPendings) {
      expect(p.parentRunId).toBe(parentRunId);
      expect((p.data as { archetype?: string }).archetype).toBe("delegate-child");
      expect(p.input).toMatchObject({ emplId: expect.any(String) });
    }
    const sigEids = sigPendings.map((p) => (p.input as { emplId: string }).emplId).sort();
    expect(sigEids).toEqual(["E1", "E2", "E3"]);

    // Every signature child should also have a terminal `done` row.
    const sigDones = sigLines.filter((l) => l.status === "done");
    expect(sigDones.length).toBe(3);
  });
});
