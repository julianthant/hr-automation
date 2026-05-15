import { registerLocalFile } from "./files.js";
import { isStateDbReady, openStateDb } from "../state/db.js";

type DownloadKind = "kronos-report" | "crm-document";

interface RegisterDownloadedFileInput {
  kind: DownloadKind;
  path: string;
  originalName: string;
  workflow: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  trackerDir?: string;
}

const SOURCE_BY_KIND: Record<DownloadKind, string> = {
  "kronos-report": "old-kronos-download",
  "crm-document": "crm-idocs-download",
};

export function registerDownloadedFile(input: RegisterDownloadedFileInput): void {
  const trackerDir = input.trackerDir ?? ".tracker";
  if (!isStateDbReady(trackerDir)) return;
  registerLocalFile(openStateDb(trackerDir), {
    kind: "pdf",
    mimeType: "application/pdf",
    path: input.path,
    originalName: input.originalName,
    source: SOURCE_BY_KIND[input.kind],
    workflow: input.workflow,
    itemId: input.itemId,
    runId: input.runId,
    parentRunId: input.parentRunId,
  });
}

export function tryRegisterDownloadedFile(input: RegisterDownloadedFileInput): void {
  try {
    registerDownloadedFile(input);
  } catch {
    // File registration is best-effort; the download itself remains successful.
  }
}
