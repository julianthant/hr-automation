import { homedir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { ensureDaemonsAndEnqueue } from "../../core/daemon/client.js";
import { buildOperatorSubject, operatorSubjectData } from "../../domain/operator-subject.js";
import { loginToACTCrm } from "../../infra/auth/login.js";
import {
  buildCrmDocumentDownloadPath,
  downloadCrmIdocsDocuments,
  searchCrmOnboardingRecords,
  selectLatestResult,
} from "../../systems/crm/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { CrmDocDownloadInputSchema, type CrmDocDownloadInput } from "./schema.js";

const crmDocDownloadSteps = ["search-record", "download"] as const;
const WORKFLOW = "crm-doc-download";

export const crmDocDownloadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "CRM Doc Download",
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
  authChain: "sequential",
  batch: { mode: "pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "emplId", label: "EID" },
    { key: "email", label: "Email" },
    { key: "pdfDownload", label: "PDFs" },
    { key: "pdfFolder", label: "Folder" },
    { key: "originWorkflow", label: "Origin" },
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
      ...(input.originWorkflow ? { originWorkflow: input.originWorkflow } : {}),
      ...(input.parentSubject ? { parentSubject: input.parentSubject } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.taskGroupId ? { taskGroupId: input.taskGroupId } : {}),
      taskRole: input.originWorkflow ? "utility" : "root",
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
  return input.email ?? input.emplId ?? "";
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

export async function runCrmDocDownloadCli(
  emails: string[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (emails.length === 0) {
    log.error("runCrmDocDownloadCli: no emails provided");
    process.exitCode = 1;
    return;
  }

  const inputs = emails.map((email) => ({ email }));
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    crmDocDownloadWorkflow,
    inputs,
    { new: options.new, parallel: options.parallel },
    {
      onPreEmitPending: (item, runId, parentRunId) => {
        const subject = crmDocDownloadWorkflow.config.operatorSubject?.(item);
        const id = deriveCrmDocDownloadItemId(item);
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id,
          runId,
          ...(parentRunId ? { parentRunId } : {}),
          status: "pending",
          data: {
            ...(item.email ? { email: item.email } : {}),
            ...(item.emplId ? { emplId: item.emplId } : {}),
            taskRole: "root",
            ...operatorSubjectData(subject),
          },
        });
      },
      onPreEmitFailed: (item, runId, error) => {
        const id = deriveCrmDocDownloadItemId(item);
        trackEvent({
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id,
          runId,
          status: "failed",
          data: {
            ...(item.email ? { email: item.email } : {}),
            ...(item.emplId ? { emplId: item.emplId } : {}),
            taskRole: "root",
          },
          error: `Spawn failed before enqueue: ${errorMessage(error)}`,
        });
      },
    },
  );
}
