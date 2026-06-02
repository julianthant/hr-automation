/**
 * Contract 3 scenario test — OCR-hub fan-out shape.
 *
 * Models the new oath shape with synthetic workflows: an OCR-like parent fans
 * out to N signer-like children (batch members) PLUS one upload-like child
 * (single), all parented to the OCR run. This exercises the generic kernel
 * delegation contract (parentRunId stamping, archetype derivation, pristine
 * input persistence) for a parent that delegates to two different children —
 * the shape the real OCR approve route produces.
 *
 * (The real approve fan-out runs through `/api/ocr/approve-batch` +
 * `ensureDaemonsAndEnqueue`, which the scenario harness doesn't model; the
 * end-to-end approve→signers→upload-wait behavior is covered by the unit tests
 * in tests/unit/tracker/dashboard/ocr-approve* and
 * tests/unit/workflows/oath-upload/handler.test.ts.)
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

describe("ocr-hub fan-out shape via ctx.delegateToAll(signers) + ctx.delegateTo(upload)", () => {
  test("OCR-like parent → N signer batch members + one upload child, all parented", async (t) => {
    const trackerDir = mkdtempSync(join(tmpdir(), "delegate-shape-"));
    t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));

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

    const uploadLikeChild = defineWorkflow({
      name: "scen-upload-like",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["file-ticket"] as const,
      schema: z.object({ sessionId: z.string() }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ sessionId: input.sessionId });
        await ctx.step("file-ticket", async () => {});
      },
    });

    // Synthetic OCR-like parent: on "approve" it fans out signer children
    // (batch) AND one upload child (single), all parented to its own run —
    // exactly the dual fan-out the real OCR approve route performs.
    const ocrHubLike = defineWorkflow({
      name: "scen-ocr-hub-like",
      archetype: "preview",
      systems: [],
      authSteps: false,
      steps: ["approve"] as const,
      schema: z.object({ sessionId: z.string(), eids: z.array(z.string()) }),
      detailFields: [{ key: "sessionId", label: "Session" }],
      getName: (d) => d.sessionId ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.updateData({ sessionId: input.sessionId });
        await ctx.step("approve", async () => {
          await ctx.delegateToAll(
            sigLikeChild,
            input.eids.map((emplId) => ({ emplId })),
            { renderAs: "batch" },
          );
          await ctx.delegateTo(
            uploadLikeChild,
            { sessionId: input.sessionId },
            { itemId: input.sessionId },
          );
        });
      },
    });

    await runWorkflow(ocrHubLike, { sessionId: "sess-abc", eids: ["E1", "E2", "E3"] }, { trackerDir });

    const hubLines = readWorkflowLines(trackerDir, "scen-ocr-hub-like");
    const hubPending = hubLines.find((l) => l.status === "pending");
    const hubDone = hubLines.find((l) => l.status === "done");
    expect((hubPending?.data as { archetype?: string }).archetype).toBe("preview");
    expect(hubDone).toBeDefined();
    expect(hubDone?.parentRunId).toBeUndefined();

    const hubRunId = hubPending?.runId;
    expect(hubRunId).toBeDefined();

    // Signer children: batch members parented to the OCR run.
    const sigLines = readWorkflowLines(trackerDir, "scen-sig-like");
    const sigPendings = sigLines.filter((l) => l.status === "pending");
    expect(sigPendings.length).toBe(3);
    for (const p of sigPendings) {
      expect(p.parentRunId).toBe(hubRunId);
      expect((p.data as { archetype?: string }).archetype).toBe("batch-member");
      expect(p.input).toMatchObject({ emplId: expect.any(String) });
    }
    const sigEids = sigPendings.map((p) => (p.input as { emplId: string }).emplId).sort();
    expect(sigEids).toEqual(["E1", "E2", "E3"]);
    expect(sigLines.filter((l) => l.status === "done").length).toBe(3);

    // Upload child: a single row parented to the OCR run.
    const uploadLines = readWorkflowLines(trackerDir, "scen-upload-like");
    const uploadPending = uploadLines.find((l) => l.status === "pending");
    expect(uploadPending).toBeDefined();
    expect(uploadPending?.parentRunId).toBe(hubRunId);
    expect((uploadPending?.data as { archetype?: string }).archetype).toBe("single");
    expect(uploadPending?.input).toEqual({ sessionId: "sess-abc" });
    expect(uploadPending?.id).toBe("sess-abc");
    expect(uploadLines.find((l) => l.status === "done")).toBeDefined();
  });
});
