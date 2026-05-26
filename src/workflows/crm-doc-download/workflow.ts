import { homedir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToACTCrm } from "../../infra/auth/login.js";
import {
  buildCrmDocumentDownloadPath,
  downloadCrmIdocsDocuments,
  searchCrmOnboardingRecords,
  selectLatestResult,
} from "../../systems/crm/index.js";
import { emitTrackerRow } from "../../tracker/jsonl.js";
import { deriveRowArchetype } from "../../domain/row-archetype.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { CrmDocDownloadInputSchema, type CrmDocDownloadInput } from "./schema.js";

const crmDocDownloadSteps = ["search-record", "download"] as const;
const WORKFLOW = "crm-doc-download";

export const CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

export const crmDocDownloadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "CRM Doc Download",
  archetype: "utility",
  category: "Utils",
  iconName: "Download",
  systems: [
    {
      id: "crm",
      login: async (page, instance, context) => {
        const ok = await loginToACTCrm(page, instance, context?.abortSignal);
        if (!ok) throw new Error("ACT CRM authentication failed");
      },
    },
  ],
  authSteps: true,
  steps: crmDocDownloadSteps,
  schema: CrmDocDownloadInputSchema,
  runtimePolicy: CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY,
  authChain: "sequential",
  batch: { mode: "pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "emplId", label: "EID" },
    { key: "email", label: "Email" },
    { key: "pdfDownload", label: "PDFs" },
    { key: "pdfFolder", label: "Folder" },
  ],
  getName: (d) => [d.firstName, d.lastName].filter(Boolean).join(" ") || d.email || d.emplId || "",
  getId: (d) => d.email ?? d.emplId ?? "",
  deriveItemId: (input) => deriveCrmDocDownloadItemId(input),
  operatorSubject: (input) =>
    input.emplId
      ? buildOperatorSubject({ kind: "eid", value: input.emplId, prefix: "CRM Docs" })
      : buildOperatorSubject({ kind: "email", value: input.email, prefix: "CRM Docs" }),
  handler: async (ctx, input) => {
    ctx.updateData({
      ...(input.email ? { email: input.email } : {}),
      ...(input.emplId ? { emplId: input.emplId } : {}),
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      ...(input.middleName ? { middleName: input.middleName } : {}),
      ...(input.parentSubject ? { parentSubject: input.parentSubject } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.taskGroupId ? { taskGroupId: input.taskGroupId } : {}),
    });

    const page = await ctx.page("crm");

    await ctx.step("search-record", async () => {
      await ctx.retry(() => searchCrmOnboardingRecords(page, resolveCrmDocDownloadSearchQuery(input)), { attempts: 3 });
      await ctx.retry(() => selectLatestResult(page), { attempts: 3 });
    });

    await ctx.step("download", async () => {
      const folderPath = resolveCrmDocDownloadFolder(input);
      const saved = await ctx.retry(
        () =>
          downloadCrmIdocsDocuments(page, folderPath, {
            docIndices: input.docIndices,
            workflow: WORKFLOW,
            itemId: deriveCrmDocDownloadItemId(input),
            runId: ctx.runId,
            parentRunId: input.parentRunId,
          }),
        { attempts: 2, backoffMs: 2_000 },
      );
      ctx.updateData({
        pdfDownload: `${saved.length} file(s)`,
        pdfFolder: folderPath,
      });
    });
  },
});

export function deriveCrmDocDownloadItemId(input: CrmDocDownloadInput): string {
  if (input.email) return input.email;
  if (input.emplId) return input.emplId;
  throw new Error("crm-doc-download requires email or emplId");
}

function resolveCrmDocDownloadSearchQuery(input: CrmDocDownloadInput): string {
  const query = input.email ?? input.emplId;
  if (!query) throw new Error("crm-doc-download requires email or emplId");
  return query;
}

function resolveCrmDocDownloadFolder(input: CrmDocDownloadInput): string {
  if (input.folderPath) return input.folderPath;
  if (input.firstName && input.lastName) {
    return buildCrmDocumentDownloadPath({
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName,
    });
  }
  return join(homedir(), "Downloads", "onboarding", `${resolveCrmDocDownloadSearchQuery(input)} EID`);
}

export async function runCrmDocDownload(input: CrmDocDownloadInput): Promise<void> {
  await runWorkflow(crmDocDownloadWorkflow, input);
  log.success("CRM document download completed successfully");
}

function buildCrmDocDownloadPendingData(input: CrmDocDownloadInput): Record<string, string> {
  return {
    ...(input.email ? { email: input.email } : {}),
    ...(input.emplId ? { emplId: input.emplId } : {}),
  };
}

export const runCrmDocDownloadCli = buildCliAdapter<[string[]], CrmDocDownloadInput>({
  workflow: crmDocDownloadWorkflow,
  emptyMessage: "runCrmDocDownloadCli: no emails provided",
  buildInputs: (emails) => emails.map((email) => ({ email })),
  deriveItemId: deriveCrmDocDownloadItemId,
  buildPendingData: (input) => buildCrmDocDownloadPendingData(input),
  onPreEmitFailed: (input, runId, error, itemId) => {
    emitTrackerRow({
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: itemId,
      runId,
      status: "failed",
      // crm-doc-download is "utility" — when invoked as a delegate it
      // surfaces as passive-child, otherwise single (deriveRowArchetype
      // does the right thing for both cases).
      data: {
        ...buildCrmDocDownloadPendingData(input),
        archetype: deriveRowArchetype("utility", undefined),
      },
      error: `Spawn failed before enqueue: ${errorMessage(error)}`,
    });
  },
});
