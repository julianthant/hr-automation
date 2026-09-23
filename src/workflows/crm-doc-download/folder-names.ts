import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ExcelJS from "exceljs";
import { resolveRosterDirs } from "../../services/matching/roster-loader.js";
import { parseCsv } from "../../utils/csv.js";
import type { CrmDocDownloadInput } from "./schema.js";
import {
  folderSubjectFromLegalLived,
  type CrmDocumentFolderSubject,
} from "../../systems/crm/document-folder-subject.js";

export { folderSubjectFromLegalLived };
export type CrmDocDownloadFolderSubject = CrmDocumentFolderSubject;

export interface OnboardingLegalLivedEntry {
  email: string;
  legalName: string;
  livedName: string;
}

/**
 * Parse the HDH / SharePoint onboarding roster CSV. Email is often column 0
 * (`Email,Legal Name,Lived Name`); a `> 0` check would skip that header.
 */
export function parseOnboardingLegalLivedCsv(text: string): OnboardingLegalLivedEntry[] {
  const rows = parseCsv(text.replace(/\u00a0/g, " "));
  let emailCol = -1;
  let legalCol = -1;
  let livedCol = -1;
  let headerIdx = -1;

  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const textCell = row[c].trim();
      if (/^email$/i.test(textCell)) emailCol = c;
      if (/^legal\s*name$/i.test(textCell)) legalCol = c;
      if (/^lived\s*name$/i.test(textCell)) livedCol = c;
    }
    if (emailCol >= 0 && (legalCol >= 0 || livedCol >= 0)) {
      headerIdx = r;
      break;
    }
  }

  if (headerIdx === -1 || emailCol === -1) {
    throw new Error("onboarding roster CSV has no Email + Legal Name / Lived Name header");
  }

  const out: OnboardingLegalLivedEntry[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const email = (row[emailCol] ?? "").trim();
    if (!email || !email.includes("@")) continue;
    const legalName = legalCol >= 0 ? (row[legalCol] ?? "").trim() : "";
    const livedName = livedCol >= 0 ? (row[livedCol] ?? "").trim() : "";
    if (!legalName && !livedName) continue;
    out.push({ email, legalName, livedName });
  }
  return out;
}

export function lookupLegalLivedEntry(
  entries: OnboardingLegalLivedEntry[],
  email: string,
): OnboardingLegalLivedEntry | undefined {
  const target = email.trim().toLowerCase();
  return entries.find((entry) => entry.email.trim().toLowerCase() === target);
}

/**
 * Name fields for the download folder. Explicit input names win; otherwise
 * Legal vs Lived come from the onboarding roster. Returns null for an EID-only
 * run so the caller can look up the roster after extracting the record email.
 * Throws rather than falling back to CRM (CRM First Name is often the lived name).
 */
export function resolveCrmDocDownloadNameFields(
  input: Pick<CrmDocDownloadInput, "email" | "emplId" | "firstName" | "lastName" | "middleName" | "livedName">,
  roster: OnboardingLegalLivedEntry[],
): CrmDocDownloadFolderSubject | null {
  if (input.firstName && input.lastName) {
    return {
      firstName: input.firstName,
      lastName: input.lastName,
      ...(input.middleName ? { middleName: input.middleName } : {}),
      ...(input.livedName ? { livedName: input.livedName } : {}),
    };
  }

  if (!input.email) return null;

  const entry = lookupLegalLivedEntry(roster, input.email);
  if (!entry) {
    throw new Error(
      `crm-doc-download: "${input.email}" was not found on the onboarding roster. ` +
        `Refusing to name the folder from CRM (CRM First Name is often the lived name).`,
    );
  }
  if (!entry.legalName.trim()) {
    throw new Error(
      `crm-doc-download: "${input.email}" is on the onboarding roster but Legal Name is empty.`,
    );
  }
  return folderSubjectFromLegalLived(entry.legalName, entry.livedName);
}

export function resolveFolderSubjectFromRecordEmails(
  emails: Array<string | null | undefined>,
  roster: OnboardingLegalLivedEntry[],
  emplId: string,
): CrmDocDownloadFolderSubject {
  const tried: string[] = [];
  for (const raw of emails) {
    const email = (raw ?? "").trim();
    if (!email) continue;
    tried.push(email);
    const entry = lookupLegalLivedEntry(roster, email);
    if (!entry) continue;
    if (!entry.legalName.trim()) {
      throw new Error(
        `crm-doc-download: "${email}" is on the onboarding roster but Legal Name is empty.`,
      );
    }
    return folderSubjectFromLegalLived(entry.legalName, entry.livedName);
  }
  throw new Error(
    `crm-doc-download: EID ${emplId} record email(s) [${tried.join(", ") || "none"}] ` +
      `were not found on the onboarding roster. Refusing to name the folder from CRM.`,
  );
}

const ROSTER_EXTENSIONS = new Set([".xlsx", ".csv"]);

/**
 * Newest roster file, preferring a filename that contains "onboarding".
 * Pass a single directory in tests; production walks the shared roster dirs.
 */
export function findOnboardingLegalLivedRosterPath(searchDir?: string): string | undefined {
  const dirs = searchDir ? [searchDir] : resolveRosterDirs();
  const candidates: Array<{ path: string; mtimeMs: number; filename: string }> = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (!ROSTER_EXTENSIONS.has(extname(filename).toLowerCase())) continue;
      const filePath = join(dir, filename);
      try {
        const s = statSync(filePath);
        candidates.push({ path: filePath, mtimeMs: s.mtimeMs, filename });
      } catch {
        continue;
      }
    }
  }
  if (candidates.length === 0) return undefined;
  const onboardingFiles = candidates.filter((c) => /onboarding/i.test(c.filename));
  const pool = onboardingFiles.length > 0 ? onboardingFiles : candidates;
  pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pool[0].path;
}

export async function loadOnboardingLegalLivedEntries(filePath: string): Promise<OnboardingLegalLivedEntry[]> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".csv") {
    return parseOnboardingLegalLivedCsv(readCsvText(filePath));
  }
  if (ext === ".xlsx") {
    return parseOnboardingLegalLivedXlsx(filePath);
  }
  throw new Error(`crm-doc-download: unsupported onboarding roster extension "${ext}" (${filePath})`);
}

function readCsvText(filePath: string): string {
  const buf = readFileSync(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Excel "CSV" from HDH is often windows-1252/latin-1 (nbsp 0xa0).
    return new TextDecoder("latin1").decode(buf);
  }
}

async function parseOnboardingLegalLivedXlsx(filePath: string): Promise<OnboardingLegalLivedEntry[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out: OnboardingLegalLivedEntry[] = [];

  for (const ws of wb.worksheets) {
    let emailCol = -1;
    let legalCol = -1;
    let livedCol = -1;
    let headerRow = -1;

    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const row = ws.getRow(r);
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = cellToString(cell.value).trim();
        if (/^email$/i.test(text)) emailCol = colNumber;
        if (/^legal\s*name$/i.test(text)) legalCol = colNumber;
        if (/^lived\s*name$/i.test(text)) livedCol = colNumber;
      });
      if (emailCol > 0 && (legalCol > 0 || livedCol > 0)) {
        headerRow = r;
        break;
      }
    }

    if (headerRow === -1 || emailCol === -1) continue;

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const email = cellToString(row.getCell(emailCol).value).trim();
      if (!email || !email.includes("@")) continue;
      const legalName = legalCol > 0 ? cellToString(row.getCell(legalCol).value).trim() : "";
      const livedName = livedCol > 0 ? cellToString(row.getCell(livedCol).value).trim() : "";
      if (!legalName && !livedName) continue;
      out.push({ email, legalName, livedName });
    }
  }

  if (out.length === 0) {
    throw new Error(`crm-doc-download: no Email/Legal Name rows in onboarding roster ${filePath}`);
  }
  return out;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
    if (typeof v.hyperlink === "string") return v.hyperlink;
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((seg) => (seg && typeof (seg as { text?: unknown }).text === "string" ? (seg as { text: string }).text : ""))
        .join("");
    }
    if (typeof v.result === "string" || typeof v.result === "number") {
      return String(v.result);
    }
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "[unserializable cell]";
    }
  }
  return "";
}
