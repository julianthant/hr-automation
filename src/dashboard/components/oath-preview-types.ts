/**
 * Frontend-side types for the oath-signature paper-roster preview row.
 * Mirrors backend schemas in `src/workflows/oath-signature/preview-schema.ts`
 * but kept as plain TypeScript so the bundle doesn't pull in Zod's runtime.
 */

export type OathMatchState =
  | "extracted"
  | "matched"
  | "lookup-pending"
  | "lookup-running"
  | "resolved"
  | "unresolved";

export type OathMatchSource = "roster" | "eid-lookup" | "llm";

export type { Verification } from "./preview-types";
import type { Verification } from "./preview-types";

export interface OathPreviewRecord {
  sourcePage: number;
  rowIndex: number;
  printedName: string;
  employeeSigned: boolean;
  officerSigned?: boolean | null;
  dateSigned: string | null;
  notes: string[];
  employeeId: string;
  matchState: OathMatchState;
  matchSource?: OathMatchSource;
  matchConfidence?: number;
  rosterCandidates?: Array<{ eid: string; name: string; score: number }>;
  documentType?: "expected" | "unknown";
  originallyMissing?: string[];
  verification?: Verification;
  selected: boolean;
  warnings: string[];
}

export interface OathPrepareRowData {
  mode: "prepare";
  pdfPath: string;
  pdfOriginalName: string;
  rosterPath: string;
  pageImagesDir?: string;
  records: OathPreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
}

export function parseOathPrepareRowData(
  rawData: Record<string, string> | undefined,
): OathPrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  let records: OathPreviewRecord[] = [];
  try {
    const parsed = JSON.parse(rawData.records ?? "[]");
    if (Array.isArray(parsed)) records = parsed as OathPreviewRecord[];
  } catch {
    return null;
  }
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
  };
}
