import type { Page } from "playwright";
import type { Ctx } from "../../core/kernel/types.js";
import { log } from "../../utils/log.js";
import { openControlDb } from "../../core/control-db.js";
import { getRegisteredFile } from "../../tracker/files/files.js";
import { loginToOnBase } from "../../infra/auth/login.js";
import { extractPdfPage } from "../../services/ocr/pdf-pages.js";
import {
  openImportDocument,
  selectDocumentType,
  selectFileType,
  ensureKeyset,
  chooseFile,
  enterUcpathIdAndTab,
  readRequiredKeywordValues,
  fillKeyword,
  setDocumentName,
  isImportEnabled,
  clickImport,
  ONBASE_PDF_FILE_TYPE,
  ONBASE_EMPLOYEE_LOOKUP_KEYSET,
} from "../../systems/onbase/index.js";
import type { OnbaseInput } from "./schema.js";

export const onbaseSteps = [
  "authenticate",
  "prepare-import",
  "fill-keywords",
  "import",
] as const;
export type OnbaseSteps = typeof onbaseSteps;

export interface OnbaseHandlerOpts {
  trackerDir?: string;
  /** Replaces the registered-file → storage-path resolution (tests). */
  _resolvePdfPathOverride?: (input: OnbaseInput, trackerDir: string | undefined) => string;
  /** Replaces `ctx.page("onbase")` (tests / stub mode with `systems: []`). */
  _pageOverride?: () => Promise<Page>;
}

/**
 * Map the fallback fields onto their OnBase keyword labels. Used only when the
 * Employee Lookup keyset comes up empty (bad/unknown UCPath ID) — normally the
 * keyset autofills every one of these. Document Name is set unconditionally
 * elsewhere; UCPath ID is already entered.
 */
function fallbackKeywordValues(input: OnbaseInput): Record<string, string | undefined> {
  return {
    "Last Name": input.lastName,
    "First Name": input.firstName,
    "Middle Name": input.middleName,
    Suffix: input.suffix,
    "Department Name": input.departmentName,
    "Department Code": input.departmentCode,
    "Vice Chancellor": input.viceChancellor,
    "Vice Chancellor Code": input.viceChancellorCode,
  };
}

/** Resolve the combined PDF's on-disk path from its registered-file id. */
function resolvePdfPath(input: OnbaseInput, trackerDir: string | undefined): string {
  let db: ReturnType<typeof openControlDb> | undefined;
  try {
    db = openControlDb({ trackerDir });
    const registered = getRegisteredFile(db.db, input.pdfFileId);
    if (!registered) {
      throw new Error(
        `onbase: no registered file for pdfFileId=${input.pdfFileId} (UCPath ID ${input.ucpathId})`,
      );
    }
    return registered.storagePath;
  } finally {
    db?.close();
  }
}

/**
 * Import one person's Emergency Contact document into OnBase.
 *
 * Happy path: open Import Document → select doc type + File Type PDF + Employee
 * Lookup keyset → attach this person's single page → type UCPath ID + Tab (the
 * keyset autofills every keyword) → set Document Name constant → verify the
 * required keywords are filled → Import. If the keyset returns nothing, fill the
 * required keywords from the OCR / person-lookup fallback data first.
 */
export async function onbaseHandler(
  ctx: Ctx<OnbaseSteps, OnbaseInput>,
  input: OnbaseInput,
  opts: OnbaseHandlerOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir ?? ctx.trackerDir;
  const page = opts._pageOverride ? await opts._pageOverride() : await ctx.page("onbase");

  ctx.updateData({
    ucpathId: input.ucpathId,
    employeeName: input.employeeName ?? "",
    documentType: input.documentType,
    sourcePage: input.sourcePage,
    ...(input.pdfOriginalName ? { pdfOriginalName: input.pdfOriginalName } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  await ctx.step("authenticate", async () => {
    // Deferred auth: the fan-out child only Duos here, after OCR approval.
    // loginToOnBase is idempotent — a daemon Duos once and reuses the session.
    const ok = await loginToOnBase(page, ctx.workflowInstance, ctx.signal);
    if (!ok) throw new Error("OnBase authentication failed");
  });

  await ctx.step("prepare-import", async () => {
    await openImportDocument(page);
    await selectDocumentType(page, input.documentType);
    await selectFileType(page, ONBASE_PDF_FILE_TYPE);
    await ensureKeyset(page, ONBASE_EMPLOYEE_LOOKUP_KEYSET);

    const pdfPath = (opts._resolvePdfPathOverride ?? resolvePdfPath)(input, trackerDir);
    const pageBytes = await extractPdfPage(pdfPath, input.sourcePage);
    await chooseFile(page, {
      name: `${input.ucpathId}-p${input.sourcePage}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from(pageBytes),
    });
  });

  let autofilled = false;
  await ctx.step("fill-keywords", async () => {
    autofilled = await enterUcpathIdAndTab(page, input.ucpathId);
    await setDocumentName(page, input.documentName);

    if (!autofilled) {
      const fallback = fallbackKeywordValues(input);
      for (const [label, value] of Object.entries(fallback)) {
        if (value && value.trim()) await fillKeyword(page, label, value.trim());
      }
    }

    // Fail loud if any required ("red") keyword is still blank — never import an
    // incompletely-keyed document.
    const values = await readRequiredKeywordValues(page);
    const missing = Object.entries(values)
      .filter(([, v]) => !v.trim())
      .map(([label]) => label);
    if (missing.length > 0) {
      throw new Error(
        `OnBase: required keyword(s) still empty after autofill+fallback for UCPath ID ${input.ucpathId}: ${missing.join(", ")} (keyset autofilled=${autofilled})`,
      );
    }
    ctx.updateData({ keysetAutofilled: autofilled ? "true" : "false" });
  });

  await ctx.step("import", async () => {
    if (input.dryRun) {
      await ctx.screenshot({ kind: "form", label: "onbase-dry-run-pre-import" });
      ctx.updateData({ status: "Dry Run Complete" });
      log.success(
        `OnBase dry run complete for UCPath ID ${input.ucpathId} — Import skipped.`,
      );
      return;
    }
    if (!(await isImportEnabled(page))) {
      throw new Error(
        `OnBase: Import button disabled for UCPath ID ${input.ucpathId} — refusing to import.`,
      );
    }
    await clickImport(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await ctx.screenshot({ kind: "form", label: "onbase-imported" });
    ctx.updateData({ status: "Imported" });
    log.success(`OnBase: imported Emergency Contact for UCPath ID ${input.ucpathId}`);
  });
}
