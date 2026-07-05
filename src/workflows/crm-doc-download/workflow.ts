import type { Page } from "playwright";
import { rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { PATHS } from "../../config.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToACTCrm } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import {
  buildCrmDocumentDownloadPath,
  buildCrmDocumentFolderName,
  sanitizeOnboardingFolderName,
  downloadCrmIdocsDocuments,
  extractCrmPersonName,
  extractField,
  navigateToSection,
  searchCrmOnboardingRecords,
  selectLatestResult,
  type CrmPersonName,
} from "../../systems/crm/index.js";
import { emitTrackerRow } from "../../tracker/jsonl.js";
import { deriveRowArchetype } from "../../domain/row-archetype.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { withFileLock, zipFolderInto } from "../../utils/zip.js";
import { CrmDocDownloadInputSchema, type CrmDocDownloadInput } from "./schema.js";

const crmDocDownloadSteps = ["search-record", "download", "archive"] as const;
const WORKFLOW = "crm-doc-download";

export const CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

export const crmDocDownloadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "CRM Doc Download",
  archetype: "single",
  inputSubject: (input) => (input.email ? "email" : "eid"),
  code: "cd",
  category: "Utils",
  iconName: "Download",
  systems: [
    {
      id: "crm",
      login: requireLogin(loginToACTCrm, "ACT CRM authentication failed"),
    },
  ],
  authSteps: true,
  steps: crmDocDownloadSteps,
  schema: CrmDocDownloadInputSchema,
  runtimePolicy: CRM_DOC_DOWNLOAD_WORKFLOW_RUNTIME_POLICY,
  batch: { mode: "pool", poolSize: 4, preEmitPending: true },
  // `emplId` and `email` are mutually exclusive per run (only one is populated
  // based on whether the input supplied an EID or email). Including both in
  // detailFields causes a "declared but never populated" warning for whichever
  // one is absent on each run. Both are surfaced via `getId` (dashboard row
  // subtitle) so they don't need to be in detailFields too.
  detailFields: [
    { key: "pdfDownload", label: "PDFs" },
    { key: "pdfFolder", label: "Folder" },
  ],
  getName: (d) => [d.firstName, d.lastName].filter(Boolean).join(" ") || d.email || d.emplId || "",
  getId: (d) => d.email ?? d.emplId ?? "",
  deriveItemId: (input) => deriveCrmDocDownloadItemId(input),
  operatorSubject: (input) =>
    input.emplId
      ? buildOperatorSubject({ kind: "eid", value: input.emplId })
      : buildOperatorSubject({ kind: "email", value: input.email }),
  handler: async (ctx, input) => {
    ctx.updateData({
      ...(input.email ? { email: input.email } : {}),
      ...(input.emplId ? { emplId: input.emplId } : {}),
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      ...(input.middleName ? { middleName: input.middleName } : {}),
      ...(input.livedName ? { livedName: input.livedName } : {}),
      ...(input.parentSubject ? { parentSubject: input.parentSubject } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.taskGroupId ? { taskGroupId: input.taskGroupId } : {}),
    });

    const page = await ctx.page("crm");

    // When the caller already supplied the name (or an explicit folder), the
    // destination is known up front and we download straight into it. Otherwise
    // (the dashboard email/EID run — the only live caller) the name comes from
    // CRM in the `archive` step, so we download into a temp folder first.
    const knownFolder = resolveKnownFinalFolder(input);
    const downloadTarget =
      knownFolder ?? join(PATHS.onboardingDocsDir, `.incoming-${ctx.runId}`);

    let savedCount = 0;

    await ctx.step("search-record", async () => {
      await ctx.retry(() => searchCrmOnboardingRecords(page, resolveCrmDocDownloadSearchQuery(input)), { attempts: 3 });
      await ctx.retry(() => selectLatestResult(page), { attempts: 3 });
      // The CRM `?q=` search is fuzzy — a query that matches nobody exactly can
      // still land on a plausible-but-wrong person's record (see
      // src/systems/crm/CLAUDE.md fuzzy-search gotcha). Confirm the selected
      // record actually belongs to the target identity BEFORE downloading
      // anything (root CLAUDE.md "Fail loud" — never download another
      // person's onboarding documents on an unverified match).
      await assertSelectedRecordMatchesIdentity(page, input);
    });

    await ctx.step("download", async () => {
      const saved = await ctx.retry(
        () =>
          downloadCrmIdocsDocuments(page, downloadTarget, {
            docIndices: input.docIndices,
            workflow: WORKFLOW,
            itemId: deriveCrmDocDownloadItemId(input),
            runId: ctx.runId,
            parentRunId: input.parentRunId,
          }),
        { attempts: 2, backoffMs: 2_000 },
      );
      savedCount = saved.length;
    });

    await ctx.step("archive", async () => {
      // Resolve the final per-person folder name. If unknown, extract the
      // person's name from the CRM UCPath Entry Sheet (best-effort: a miss
      // degrades to the search-query name rather than failing the run).
      let finalFolder = knownFolder;
      let resolvedName: CrmPersonName | undefined;
      if (!finalFolder) {
        resolvedName = await extractNameForFolder(page, input);
        const folderName =
          resolvedName.firstName && resolvedName.lastName
            ? buildCrmDocumentFolderName({
                firstName: resolvedName.firstName,
                lastName: resolvedName.lastName,
                middleName: resolvedName.middleName,
                livedName: resolvedName.livedName,
              })
            : sanitizeOnboardingFolderName(`${resolveCrmDocDownloadSearchQuery(input)} EID`);
        finalFolder = join(PATHS.onboardingDocsDir, folderName);
        if (existsSync(finalFolder)) await rm(finalFolder, { recursive: true, force: true });
        await rename(downloadTarget, finalFolder);
        ctx.updateData({
          ...(resolvedName.firstName ? { firstName: resolvedName.firstName } : {}),
          ...(resolvedName.lastName ? { lastName: resolvedName.lastName } : {}),
          ...(resolvedName.middleName ? { middleName: resolvedName.middleName } : {}),
          ...(resolvedName.livedName ? { livedName: resolvedName.livedName } : {}),
        });
      }

      // One combined zip per run: every person of a multi-input run (shared
      // `parentRunId`) appends into the same archive under a cross-process
      // lock; a single run gets its own zip named after the person. The raw
      // folder is deleted once it is in the archive.
      const archivePath = resolveArchivePath(finalFolder, input.parentRunId ?? ctx.parentRunId);
      await withFileLock(
        `${archivePath}.lock`,
        () => zipFolderInto(archivePath, finalFolder, { signal: ctx.signal }),
        { signal: ctx.signal },
      );
      await rm(finalFolder, { recursive: true, force: true });

      ctx.updateData({
        pdfDownload: `${savedCount} file(s)`,
        pdfFolder: archivePath,
      });
      log.success(`Archived ${savedCount} file(s) → ${archivePath}`);
    });
  },
});

/**
 * The final per-person folder when the caller already knows it: an explicit
 * `folderPath`, or a name supplied on the input. Returns null for the dashboard
 * email/EID run, whose name is resolved from CRM in the `archive` step.
 */
function resolveKnownFinalFolder(input: CrmDocDownloadInput): string | null {
  if (input.folderPath) return input.folderPath;
  if (input.firstName && input.lastName) {
    return buildCrmDocumentDownloadPath({
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName,
      livedName: input.livedName,
    });
  }
  return null;
}

/**
 * Best-effort structured name for the folder, preferring any name fields on the
 * input over CRM extraction. Navigates to the UCPath Entry Sheet (where the
 * labeled name fields live) and extracts; a navigation/extraction failure logs
 * and falls back to whatever the input carried (often nothing → query name).
 */
async function extractNameForFolder(
  page: Page,
  input: CrmDocDownloadInput,
): Promise<CrmPersonName> {
  let extracted: CrmPersonName = {
    firstName: null,
    lastName: null,
    middleName: null,
    livedName: null,
  };
  try {
    await navigateToSection(page, "UCPath Entry Sheet");
    extracted = await extractCrmPersonName(page);
  } catch (err) {
    log.warn(`CRM name extraction failed (folder will use the search query): ${errorMessage(err)}`);
  }
  return {
    firstName: input.firstName ?? extracted.firstName,
    lastName: input.lastName ?? extracted.lastName,
    middleName: input.middleName ?? extracted.middleName,
    livedName: input.livedName ?? extracted.livedName,
  };
}

/**
 * Confirm the CRM record `selectLatestResult` just landed on actually belongs
 * to the target identity, mirroring the search-query precedence in
 * {@link resolveCrmDocDownloadSearchQuery} (email over emplId). The CRM `?q=`
 * search is fuzzy — a query that matches nobody exactly can still return a
 * plausible-but-wrong person (`src/systems/crm/CLAUDE.md` fuzzy-search
 * gotcha; same gate shape as oath-signature's `crm-verify.ts`). "UCPath
 * Employee ID" / "UCSD Email Address" / "Personal Email Address" are the same
 * record-page labels already live-verified by `oath-signature/crm-verify.ts`
 * and `person-lookup/crm-search.ts` — not independently re-verified for THIS
 * workflow's search flow, so treat as needs-live for a final confirmation.
 *
 * A mismatch throws rather than letting the run silently download someone
 * else's onboarding documents (root CLAUDE.md "Fail loud").
 */
async function assertSelectedRecordMatchesIdentity(
  page: Page,
  input: CrmDocDownloadInput,
): Promise<void> {
  if (input.email) {
    const [ucsdEmail, personalEmail] = await Promise.all([
      extractField(page, "UCSD Email Address"),
      extractField(page, "Personal Email Address"),
    ]);
    if (!emailMatchesIdentity([ucsdEmail, personalEmail], input.email)) {
      throw new Error(
        `CRM identity mismatch: search for email "${input.email}" opened a record whose UCSD/personal ` +
          `email did not match — refusing to download another person's documents.`,
      );
    }
    return;
  }
  if (input.emplId) {
    const recordEmplId = await extractField(page, "UCPath Employee ID");
    if (!emplIdMatchesIdentity(recordEmplId, input.emplId)) {
      throw new Error(
        `CRM identity mismatch: search for EID ${input.emplId} opened a record with UCPath Employee ID ` +
          `"${recordEmplId ?? "(none)"}" — refusing to download another person's documents.`,
      );
    }
    return;
  }
  // Schema requires email or emplId (CrmDocDownloadInputSchema .refine), so
  // this branch is unreachable in practice.
}

/** Digits-only equality between a CRM record's EID field and the target EID. Pure + unit-tested. */
export function emplIdMatchesIdentity(
  recordEmplId: string | null | undefined,
  targetEmplId: string,
): boolean {
  const record = onlyDigits(recordEmplId);
  return record.length > 0 && record === onlyDigits(targetEmplId);
}

/** Case-insensitive match of the target email against any of the record's extracted email fields. Pure + unit-tested. */
export function emailMatchesIdentity(
  recordEmails: Array<string | null | undefined>,
  targetEmail: string,
): boolean {
  const target = targetEmail.trim().toLowerCase();
  return recordEmails.some((value) => (value ?? "").trim().toLowerCase() === target);
}

function onlyDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Where the run's zip lives. A multi-person run (shared `parentRunId`) collapses
 * to ONE combined archive in the onboarding dir, keyed by the batch run id so
 * every member computes the same path and appends into it. A standalone run gets
 * its own zip sitting next to (and named after) the person's folder.
 */
export function resolveArchivePath(finalFolder: string, parentRunId: string | undefined): string {
  if (parentRunId) {
    const batchKey = parentRunId.replace(/-/g, "").slice(0, 8);
    return join(PATHS.onboardingDocsDir, `Onboarding Docs ${localDateStamp()} ${batchKey}.zip`);
  }
  return join(dirname(finalFolder), `${basename(finalFolder)}.zip`);
}

/** Local YYYY-MM-DD (not UTC) for human-readable archive names. */
function localDateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
      // crm-doc-download is single-shaped; delegated presentation comes from
      // the parent row's runtime policy rather than a separate utility archetype.
      data: {
        ...buildCrmDocDownloadPendingData(input),
        archetype: deriveRowArchetype("single", undefined),
      },
      error: `Spawn failed before enqueue: ${errorMessage(error)}`,
    });
  },
});
