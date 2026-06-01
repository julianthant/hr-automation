/**
 * Contract 3 scenario test — oath-upload-style end-to-end shape.
 *
 * Parent (synthetic, modeled on oath-upload's handler shape): delegates one
 * PDF run to a synthetic oath-signature-like child. That child owns OCR
 * approval and signer fan-out.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";
import { dateLocal, rowFilePath } from "../../../src/tracker/jsonl.js";

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
  const file = rowFilePath(workflow, dateLocal(), trackerDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

describe("oath-upload-shape scenario via ctx.delegateTo(oath-signature PDF)", () => {
  test("parent → delegated PDF batch → OCR preview + signer batch children", async (t) => {
    const trackerDir = mkdtempSync(join(tmpdir(), "delegate-shape-"));
    t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

    const ocrLikeChild = defineWorkflow({
      name: "scen-ocr-like",
      archetype: "preview",
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

    const oathSignaturePdfLike = defineWorkflow({
      name: "scen-oath-signature-pdf-like",
      archetype: "batch",
      systems: [],
      authSteps: false,
      steps: ["ocr", "fan-out"] as const,
      schema: z.object({ sessionId: z.string(), eids: z.array(z.string()) }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ sessionId: input.sessionId });
        await ctx.step("ocr", async () => {
          const result = await ctx.delegateTo(
            ocrLikeChild,
            { sessionId: input.sessionId },
            { renderAs: "preview", itemId: input.sessionId },
          );
          if (result.status !== "done") throw new Error("OCR delegation did not complete");
        });
        await ctx.step("fan-out", async () => {
          await ctx.delegateToAll(
            sigLikeChild,
            input.eids.map((emplId) => ({ emplId })),
            { renderAs: "batch" },
          );
        });
      },
    });

    const parent = defineWorkflow({
      name: "scen-oath-upload-like",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["delegate-signatures"] as const,
      schema: z.object({ sessionId: z.string(), eids: z.array(z.string()) }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ sessionId: input.sessionId });
        await ctx.step("delegate-signatures", async () => {
          const result = await ctx.delegateTo(
            oathSignaturePdfLike,
            { sessionId: input.sessionId, eids: input.eids },
            { itemId: input.sessionId },
          );
          if (result.status !== "done") throw new Error("Signature delegation did not complete");
        });
      },
    });

    await runWorkflow(parent, { sessionId: "sess-abc", eids: ["E1", "E2", "E3"] }, { trackerDir });

    const parentLines = readWorkflowLines(trackerDir, "scen-oath-upload-like");
    const parentPending = parentLines.find((l) => l.status === "pending");
    const parentDone = parentLines.find((l) => l.status === "done");
    expect((parentPending?.data as { archetype?: string }).archetype).toBe("single");
    expect(parentDone).toBeDefined();
    expect(parentDone?.parentRunId).toBeUndefined();

    const parentRunId = parentPending?.runId;
    expect(parentRunId).toBeDefined();

    const pdfLines = readWorkflowLines(trackerDir, "scen-oath-signature-pdf-like");
    const pdfPending = pdfLines.find((l) => l.status === "pending");
    expect(pdfPending).toBeDefined();
    expect(pdfPending?.parentRunId).toBe(parentRunId);
    expect((pdfPending?.data as { archetype?: string }).archetype).toBe("batch");
    expect(pdfPending?.input).toEqual({ sessionId: "sess-abc", eids: ["E1", "E2", "E3"] });
    expect(pdfPending?.id).toBe("sess-abc");

    const pdfRunId = pdfPending?.runId;
    expect(pdfRunId).toBeDefined();

    const ocrLines = readWorkflowLines(trackerDir, "scen-ocr-like");
    const ocrPending = ocrLines.find((l) => l.status === "pending");
    expect(ocrPending).toBeDefined();
    expect(ocrPending?.parentRunId).toBe(pdfRunId);
    expect((ocrPending?.data as { archetype?: string }).archetype).toBe("preview");
    expect(ocrPending?.input).toEqual({ sessionId: "sess-abc" });
    expect(ocrPending?.id).toBe("sess-abc");

    const sigLines = readWorkflowLines(trackerDir, "scen-sig-like");
    const sigPendings = sigLines.filter((l) => l.status === "pending");
    expect(sigPendings.length).toBe(3);
    for (const p of sigPendings) {
      expect(p.parentRunId).toBe(pdfRunId);
      expect((p.data as { archetype?: string }).archetype).toBe("batch-member");
      expect(p.input).toMatchObject({ emplId: expect.any(String) });
    }
    const sigEids = sigPendings.map((p) => (p.input as { emplId: string }).emplId).sort();
    expect(sigEids).toEqual(["E1", "E2", "E3"]);

    const sigDones = sigLines.filter((l) => l.status === "done");
    expect(sigDones.length).toBe(3);
  });
});
