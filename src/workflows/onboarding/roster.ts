import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ExcelJS from "exceljs";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { parseCsv } from "../../utils/csv.js";
import { resolveRosterDirs } from "../../services/matching/roster-loader.js";
import { parseLastFirstName, toLastFirstName } from "../../domain/identity/person-name.js";

const ROSTER_EXTENSIONS = new Set([".xlsx", ".csv"]);

export interface OnboardingRosterEntry {
  email: string;
  legalName: string;
  livedName: string;
}

export interface ParsedNameTokens {
  firstName: string;
  middleName?: string;
  lastName: string;
}

export interface ResolvedOnboardingRosterPerson {
  legal: ParsedNameTokens;
  preferred: ParsedNameTokens;
  rawLegalName: string;
  rawLivedName: string;
  rosterPath: string;
}

/**
 * Coerce an ExcelJS cell value into a string without "[object Object]" artifacts.
 */
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
  }
  return String(value);
}

/**
 * List all onboarding roster files across the resolved roster directories,
 * sorted newest first, preferring files with "onboarding" in the filename.
 */
export function listOnboardingRosterPaths(trackerDir?: string): string[] {
  const dirs = resolveRosterDirs(trackerDir);
  const candidates: Array<{ path: string; mtimeMs: number; filename: string }> = [];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!ROSTER_EXTENSIONS.has(extname(f).toLowerCase())) continue;
      const p = join(dir, f);
      try {
        const s = statSync(p);
        candidates.push({ path: p, mtimeMs: s.mtimeMs, filename: f });
      } catch {
        continue;
      }
    }
  }

  if (candidates.length === 0) return [];

  const onboardingFiles = candidates.filter((c) => /onboarding/i.test(c.filename));
  const otherFiles = candidates.filter((c) => !/onboarding/i.test(c.filename));
  onboardingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  otherFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return [...onboardingFiles, ...otherFiles].map((c) => c.path);
}

/**
 * Find the latest onboarding roster file across the resolved roster directories.
 * Prefers files matching "onboarding", falling back to any valid roster file (.xlsx/.csv).
 */
export function findLatestOnboardingRosterPath(trackerDir?: string): string | undefined {
  return listOnboardingRosterPaths(trackerDir)[0];
}

/**
 * Parse an Excel or CSV onboarding roster file, scanning all sheets/rows for
 * Email, Legal Name, and Lived Name columns.
 */
export async function loadOnboardingRosterEntries(filePath: string): Promise<OnboardingRosterEntry[]> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".csv") {
    return parseCsvOnboardingRoster(filePath);
  }
  return parseXlsxOnboardingRoster(filePath);
}

async function parseXlsxOnboardingRoster(filePath: string): Promise<OnboardingRosterEntry[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const out: OnboardingRosterEntry[] = [];

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
      if (!email) continue;
      const legalName = legalCol > 0 ? cellToString(row.getCell(legalCol).value).trim() : "";
      const livedName = livedCol > 0 ? cellToString(row.getCell(livedCol).value).trim() : "";
      if (!legalName && !livedName) continue;
      out.push({ email, legalName, livedName });
    }
  }

  return out;
}

function parseCsvOnboardingRoster(filePath: string): OnboardingRosterEntry[] {
  const content = readFileSync(filePath, "utf-8");
  const rows = parseCsv(content);

  let emailCol = -1;
  let legalCol = -1;
  let livedCol = -1;
  let headerIdx = -1;

  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const text = row[c].trim();
      if (/^email$/i.test(text)) emailCol = c;
      if (/^legal\s*name$/i.test(text)) legalCol = c;
      if (/^lived\s*name$/i.test(text)) livedCol = c;
    }
    if (emailCol >= 0 && (legalCol >= 0 || livedCol >= 0)) {
      headerIdx = r;
      break;
    }
  }

  if (headerIdx === -1 || emailCol === -1) return [];

  const out: OnboardingRosterEntry[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const email = (row[emailCol] ?? "").trim();
    if (!email) continue;
    const legalName = legalCol >= 0 ? (row[legalCol] ?? "").trim() : "";
    const livedName = livedCol >= 0 ? (row[livedCol] ?? "").trim() : "";
    if (!legalName && !livedName) continue;
    out.push({ email, legalName, livedName });
  }

  return out;
}

/**
 * Parse a full name into firstName, middleName, and lastName components.
 */
export function parseLegalNameComponents(
  fullName: string,
  fallbackLastName?: string,
): ParsedNameTokens {
  const trimmed = fullName.trim();
  if (!trimmed) {
    throw new Error("Cannot parse empty legal name");
  }

  // Comma-separated format ("Last, First Middle" or "Last, First")
  if (trimmed.includes(",")) {
    const parsed = parseLastFirstName(trimmed);
    if (parsed) {
      return {
        firstName: parsed.firstName,
        middleName: parsed.middleName ?? undefined,
        lastName: parsed.lastName,
      };
    }
  }

  // Anchor with known last name when available
  if (fallbackLastName?.trim()) {
    const anchored = toLastFirstName(trimmed, fallbackLastName.trim());
    if (anchored.includes(",")) {
      const parsed = parseLastFirstName(anchored);
      if (parsed) {
        return {
          firstName: parsed.firstName,
          middleName: parsed.middleName ?? undefined,
          lastName: parsed.lastName,
        };
      }
    }
  }

  // Whitespace tokens: "First [Middle...] Last"
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      firstName: tokens[0],
      lastName: tokens[0],
    };
  }
  if (tokens.length === 2) {
    return {
      firstName: tokens[0],
      lastName: tokens[1],
    };
  }
  return {
    firstName: tokens[0],
    middleName: tokens.slice(1, -1).join(" "),
    lastName: tokens[tokens.length - 1],
  };
}

/**
 * Detects whether a livedName string is an upstream database truncation artifact
 * where an uppercase truncated surname was placed into the lived name field
 * (e.g. "LOPEZDELOSSAN Lopez De Los Santos" where "LOPEZDELOSSAN" is an uppercase
 * 13-char truncation of the surname "Lopez De Los Santos").
 */
export function isCorruptedLivedNameArtifact(livedName: string, legalLastName: string): boolean {
  if (!livedName || !legalLastName) return false;
  const firstToken = livedName.trim().split(/\s+/)[0] ?? "";
  if (firstToken.length < 6) return false;
  if (firstToken !== firstToken.toUpperCase()) return false;
  const cleanSurname = legalLastName.replace(/[^A-Za-z]/g, "").toUpperCase();
  const cleanToken = firstToken.replace(/[^A-Za-z]/g, "").toUpperCase();
  return cleanSurname.startsWith(cleanToken);
}

export interface ResolveRosterPersonOptions {
  email: string;
  explicitRosterPath?: string;
  parentRunId?: string;
  trackerDir?: string;
  fallbackLastName?: string;
  /** Injected for tests */
  sharePointDownloadFn?: (options: { id: string; mode: "fresh"; parentRunId?: string }) => Promise<{ path?: string }>;
}

/**
 * Resolves an employee from the onboarding roster by email.
 * Uses the latest roster; if the roster file is missing, fails to parse, or
 * does not contain the employee, downloads a fresh roster from SharePoint.
 */
export async function resolveOnboardingRosterPerson(
  options: ResolveRosterPersonOptions,
): Promise<ResolvedOnboardingRosterPerson> {
  const targetEmail = options.email.trim().toLowerCase();
  let rosterPath = options.explicitRosterPath ?? findLatestOnboardingRosterPath(options.trackerDir);
  let matchedEntry: OnboardingRosterEntry | undefined;

  if (rosterPath && existsSync(rosterPath)) {
    try {
      const entries = await loadOnboardingRosterEntries(rosterPath);
      matchedEntry = entries.find((e) => e.email.trim().toLowerCase() === targetEmail);
      if (matchedEntry) {
        log.step(`[onboarding-roster] Found "${options.email}" in local roster: ${rosterPath}`);
      } else {
        log.warn(
          `[onboarding-roster] "${options.email}" not found in local roster (${rosterPath}); `
          + (options.explicitRosterPath ? "attempting fresh download from SharePoint..." : "searching other local rosters..."),
        );
      }
    } catch (err) {
      log.warn(
        `[onboarding-roster] Failed to load local roster at "${rosterPath}": ${errorMessage(err)}; `
        + `attempting fresh download from SharePoint...`,
      );
    }
  } else {
    log.warn(
      `[onboarding-roster] No local onboarding roster found; downloading fresh roster from SharePoint...`,
    );
  }

  // If latest local roster didn't match and no explicit roster path was forced, check other local rosters before SharePoint
  if (!matchedEntry && !options.explicitRosterPath) {
    const allRosters = listOnboardingRosterPaths(options.trackerDir);
    for (const candidatePath of allRosters) {
      if (candidatePath === rosterPath) continue;
      try {
        const entries = await loadOnboardingRosterEntries(candidatePath);
        matchedEntry = entries.find((e) => e.email.trim().toLowerCase() === targetEmail);
        if (matchedEntry) {
          rosterPath = candidatePath;
          log.step(`[onboarding-roster] Found "${options.email}" in local roster: ${candidatePath}`);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // If local rosters failed or employee wasn't present, download fresh from SharePoint
  if (!matchedEntry) {
    log.step(`[onboarding-roster] Downloading fresh onboarding roster from SharePoint...`);
    const dlFn = options.sharePointDownloadFn ?? (async (opts) => {
      const { requestSharePointDownload } = await import("../sharepoint-download/index.js");
      return requestSharePointDownload(opts);
    });

    const dlResult = await dlFn({
      id: "onboarding",
      mode: "fresh",
      parentRunId: options.parentRunId,
    });

    if (!dlResult.path || !existsSync(dlResult.path)) {
      throw new Error(
        `[onboarding-roster] SharePoint download completed without a valid file path: ${dlResult.path ?? "<none>"}`,
      );
    }

    rosterPath = dlResult.path;
    const entries = await loadOnboardingRosterEntries(rosterPath);
    matchedEntry = entries.find((e) => e.email.trim().toLowerCase() === targetEmail);
  }

  if (!matchedEntry) {
    throw new Error(
      `[onboarding-roster] Employee "${options.email}" was not found on the onboarding roster `
      + `(${rosterPath ?? "<unknown>"}) even after fresh SharePoint download. `
      + `Refusing to submit transactions under CRM name which may be a lived name.`,
    );
  }

  if (!matchedEntry.legalName.trim()) {
    throw new Error(
      `[onboarding-roster] Employee "${options.email}" was found on the onboarding roster `
      + `(${rosterPath}) but has an empty "Legal Name".`,
    );
  }

  const legal = parseLegalNameComponents(matchedEntry.legalName, options.fallbackLastName);
  const isCorrupted = isCorruptedLivedNameArtifact(matchedEntry.livedName, legal.lastName);
  if (isCorrupted) {
    log.warn(
      `[onboarding-roster] Lived name "${matchedEntry.livedName}" appears to be a database truncation artifact `
      + `of last name "${legal.lastName}"; falling back to legal name.`,
    );
  }
  const preferred = (matchedEntry.livedName.trim() && !isCorrupted)
    ? parseLegalNameComponents(matchedEntry.livedName, options.fallbackLastName)
    : legal;

  return {
    legal,
    preferred,
    rawLegalName: matchedEntry.legalName,
    rawLivedName: matchedEntry.livedName,
    rosterPath: rosterPath!,
  };
}
