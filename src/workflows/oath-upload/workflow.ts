import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { runCliEntry } from "../../core/cli-adapter.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToServiceNow } from "../../infra/auth/login.js";
import { buildOperatorSubject, operatorSubjectData } from "../../domain/operator-subject.js";
import { OathUploadInputSchema, type OathUploadInput } from "./schema.js";
import { oathUploadHandler, oathUploadStepList } from "./handler.js";

const WORKFLOW = "oath-upload";

export const oathUploadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Upload",
  category: "Onboarding",
  iconName: "UploadCloud",
  systems: [
    {
      id: "servicenow",
      login: async (page, instance, context) => {
        const ok = await loginToServiceNow(page, instance, context?.abortSignal);
        if (!ok) throw new Error("ServiceNow authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: [
    "servicenow-auth",
    ...oathUploadStepList,
  ] as const,
  schema: OathUploadInputSchema,
  authChain: "sequential",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "pdfOriginalName", label: "PDF" },
    { key: "ocrSessionId",    label: "OCR session" },
    { key: "signerCount",     label: "Signers" },
    { key: "ticketNumber",    label: "HR ticket #" },
    { key: "submittedAt",     label: "Filed" },
    { key: "status",          label: "Status" },
  ],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "pdf",
      value: input.pdfOriginalName ?? input.pdfPath ?? input.sessionId,
      prefix: "Oath Upload",
    }),
  handler: async (ctx, input) => {
    ctx.markStep("servicenow-auth");
    await ctx.page("servicenow");
    await oathUploadHandler(ctx as never, input);
  },
});

/** In-process single-run entry (tests + composition). */
export async function runOathUpload(input: OathUploadInput): Promise<void> {
  try {
    await runWorkflow(oathUploadWorkflow, input);
    log.success("oath-upload workflow completed");
  } catch (err) {
    log.error(`oath-upload failed: ${errorMessage(err)}`);
    throw err;
  }
}

/** Daemon-mode CLI adapter. */
export async function runOathUploadCli(
  inputs: OathUploadInput[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (!runCliEntry(inputs.length > 0, "runOathUploadCli: no inputs provided")) return;
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    oathUploadWorkflow,
    inputs,
    { new: options.new, parallel: options.parallel },
    {
      onPreEmitPending: (item, runId, parentRunId) => {
        const subject = oathUploadWorkflow.config.operatorSubject?.(item);
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id: item.sessionId,
          runId,
          ...(parentRunId ? { parentRunId } : {}),
          status: "pending",
          data: {
            pdfPath: item.pdfPath,
            pdfOriginalName: item.pdfOriginalName,
            sessionId: item.sessionId,
            pdfHash: item.pdfHash,
            ...(item.dryRun ? { dryRun: "true" } : {}),
            ...operatorSubjectData(subject),
          },
        });
      },
      deriveItemId: (inp) => inp.sessionId,
    },
  );
}
