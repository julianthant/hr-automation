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
import { delegateToImpl } from "../../../src/core/delegate.js";
import { dateLocal, rowFilePath } from "../../../src/tracker/jsonl.js";
import { runIdFragment, tracePrefix } from "../../../src/domain/queue-trace-id.js";

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

    // Model the OCR-hub parent as part of a larger operation whose ROOT trace
    // PREFIX is already known (`ou-090553` — the oath operation's branded
    // prefix). In production OCR computes its id at the root and passes the
    // PREFIX down (orchestrator for person-lookup, approve.ts for
    // signers/upload). Here we drive the hub via `delegateToImpl` with an
    // explicit `rootTracePrefix` so the parent's `makeCtx` carries it and
    // forwards it to EVERY fan-out child — proving the whole tree (hub +
    // signers + upload) SHARES the prefix while each composes its OWN tail.
    const ROOT_PREFIX = "ou-090553";
    await delegateToImpl({
      parentRunId: "operation-root-run",
      trackerDir,
      child: ocrHubLike,
      input: { sessionId: "sess-abc", eids: ["E1", "E2", "E3"] },
      itemId: "sess-abc",
      runId: "ocr-hub-run-1a57",
      fireAndForget: false,
      rootTracePrefix: ROOT_PREFIX,
    });

    const hubLines = readWorkflowLines(trackerDir, "scen-ocr-hub-like");
    const hubPending = hubLines.find((l) => l.status === "pending");
    const hubDone = hubLines.find((l) => l.status === "done");
    expect((hubPending?.data as { archetype?: string }).archetype).toBe("preview");
    expect(hubDone).toBeDefined();
    // The hub is itself a delegated child of the operation root run.
    expect(hubDone?.parentRunId).toBe("operation-root-run");

    const hubRunId = "ocr-hub-run-1a57";
    expect(hubLines.every((l) => l.runId === hubRunId)).toBe(true);
    // The hub composes its OWN span id off the shared prefix + its own runId4.
    const hubTrace = (hubPending?.data as { __traceId?: string }).__traceId;
    expect(hubTrace).toBe(`${ROOT_PREFIX}-${runIdFragment(hubRunId)}`);
    expect(tracePrefix(hubTrace!)).toBe(ROOT_PREFIX);

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

    // ── Root trace-id propagation (trace/span model) ────────────────────────
    // Every fan-out child (signers + upload) SHARES the operation prefix
    // `ou-090553` with the OCR-like parent — one visible operation — while each
    // composes its OWN runId4 tail (individually greppable). The prefix is
    // threaded transitively from the operation root through the hub.
    expect(tracePrefix(hubTrace!)).toBe(ROOT_PREFIX);

    // Each signer row composes `<prefix>-<ownRunId4>`: shares the prefix, tail
    // matches its OWN runId, and is distinct from the parent's full id.
    for (const l of sigLines) {
      const id = (l.data as { __traceId?: string })?.__traceId;
      if (id) {
        expect(tracePrefix(id)).toBe(ROOT_PREFIX);
        expect(id).toBe(`${ROOT_PREFIX}-${runIdFragment(l.runId!)}`);
        expect(id).not.toBe(hubTrace);
      }
    }
    // The upload child rows do the same.
    for (const l of uploadLines) {
      const id = (l.data as { __traceId?: string })?.__traceId;
      if (id) {
        expect(tracePrefix(id)).toBe(ROOT_PREFIX);
        expect(id).toBe(`${ROOT_PREFIX}-${runIdFragment(l.runId!)}`);
        expect(id).not.toBe(hubTrace);
      }
    }
    // The signer pending rows definitely carry the composed id (not just "if present").
    for (const p of sigPendings) {
      const id = (p.data as { __traceId?: string }).__traceId;
      expect(tracePrefix(id!)).toBe(ROOT_PREFIX);
      expect(id).toBe(`${ROOT_PREFIX}-${runIdFragment(p.runId!)}`);
    }
    const uploadTrace = (uploadPending?.data as { __traceId?: string }).__traceId;
    expect(tracePrefix(uploadTrace!)).toBe(ROOT_PREFIX);
    expect(uploadTrace).toBe(`${ROOT_PREFIX}-${runIdFragment(uploadPending!.runId!)}`);

    // Distinct tails: every fan-out child's full id differs from the others and
    // from the parent — shared prefix, individually greppable.
    const allChildIds = [
      ...sigPendings.map((p) => (p.data as { __traceId?: string }).__traceId!),
      uploadTrace!,
    ];
    expect(new Set(allChildIds).size).toBe(allChildIds.length);
    expect(allChildIds.every((id) => id !== hubTrace)).toBe(true);

    // And each child still keeps its OWN runId (distinct from the parent's).
    expect(sigPendings.every((p) => p.runId && p.runId !== hubRunId)).toBe(true);
    expect(uploadPending?.runId && uploadPending.runId !== hubRunId).toBe(true);
  });
});
