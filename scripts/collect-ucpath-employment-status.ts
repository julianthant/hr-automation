/**
 * Read-only live collector: UCPath employment status + latest termination date,
 * built for the I-9 shred audit (operator criterion confirmed 2026-08-05).
 *
 * Per person: resolve the Empl ID behind an identity gate (prefer 2-of-3 of
 * name / DOB / ID), open Person Org Summary via the shared person-lookup
 * engine (View All handled inside `searchByName`/`searchByEid`), and report
 * every employment-instance row's HR status + termination date. Verdicts are
 * NOT issued here — the orchestrator applies the shred rule to the findings.
 *
 * Mutates NOTHING: HR-Tasks Search/Match + Person Org Summary reads only.
 *
 * Usage:
 *   HR_AUTOMATION_DUO_WEBAUTHN=1 npx tsx --env-file=.env \
 *     scripts/collect-ucpath-employment-status.ts <input.json> <output.json>
 *
 * Input JSON: [{ key, name, firstName, lastName, dob?, firstDay? }]
 *   - name: display name, "Last, First M" or "First Last" (buildLastFirstSearchNames handles both)
 *   - dob / firstDay: MM/DD/YYYY when known (S1 gives dob; S2 gives firstDay)
 */
import { readFileSync, writeFileSync } from "fs";
import { UCPATH_SMART_HR_URL } from "../src/config.js";
import { launchBrowser } from "../src/infra/browser/launch.js";
import { loginToUCPath } from "../src/infra/auth/login.js";
import { lookupPersonInUcpath } from "../src/workflows/person-lookup/lookup.js";
import type { PersonLookupResult } from "../src/workflows/person-lookup/outcome.js";
import { searchPerson } from "../src/systems/ucpath/navigate.js";
import {
  selectPersonLookupByHireDate,
  type HireDateLookupOutcome,
} from "../src/workflows/i9-check/select-by-hire-date.js";

interface PersonInput {
  key: string;
  name: string;
  firstName: string;
  lastName: string;
  dob?: string;
  firstDay?: string;
}

interface InstanceRow {
  emplId: string;
  hrStatus: string;
  department: string;
  startDate: string;
  effectiveDate: string;
  terminationDate: string;
  terminationReason: string;
}

interface PersonFinding {
  key: string;
  name: string;
  attempts: number;
  identityFactors: string[];
  resolvedEmplId: string;
  searchMatchEmplIds: string[];
  nameLookupCandidateEids: string[];
  hireDateGate: HireDateLookupOutcome | null;
  /** EID contradiction between the DOB factor and the hire-date factor — blocks resolution. */
  conflict: string;
  /** Search/Match infrastructure failure — the DOB factor is MISSING, not contradicted. */
  searchMatchError: string;
  rows: InstanceRow[];
  anyActive: boolean | null;
  latestTerminationDate: string;
  fiveYearsElapsed: boolean | null;
  status: "active" | "terminated" | "not-found" | "ambiguous" | "unresolved-dates" | "error";
  error: string;
}

const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function parseUsDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!US_DATE.test(trimmed)) return null;
  const [m, d, y] = trimmed.split("/").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

/** Mirrors outcome.ts isInactiveResult: term date present OR inactive-ish hrStatus. */
function rowIsInactive(row: InstanceRow): boolean {
  const term = row.terminationDate.trim();
  const hasTermDate = term.length > 0 && term !== "Active";
  return hasTermDate || /inactive|terminated|separated/i.test(row.hrStatus);
}

function toInstanceRow(r: PersonLookupResult): InstanceRow {
  return {
    emplId: r.emplId,
    hrStatus: r.hrStatus ?? "",
    department: r.department ?? "",
    startDate: r.startDate ?? "",
    effectiveDate: r.effectiveDate ?? "",
    terminationDate: r.terminationDate && r.terminationDate !== "Active" ? r.terminationDate : "",
    terminationReason: r.terminationReason ?? "",
  };
}

function fiveYearsElapsedSince(termination: Date, today: Date): boolean {
  const boundary = new Date(termination);
  boundary.setFullYear(boundary.getFullYear() + 5);
  return boundary.getTime() <= today.getTime();
}

async function checkPerson(
  page: import("playwright").Page,
  person: PersonInput,
): Promise<Omit<PersonFinding, "attempts">> {
  // Identity factor 2a FIRST: DOB via HR-Tasks Search/Match (name+DOB; SSN never
  // supplied) — same step order as i9-check's person-match → person-lookup.
  let searchMatchEmplIds: string[] = [];
  let searchMatchError = "";
  if (person.dob && person.firstName && person.lastName) {
    try {
      const match = await searchPerson(page, "", person.firstName, person.lastName, person.dob);
      searchMatchEmplIds = (match.matches ?? []).map((m) => m.emplId).filter(Boolean);
    } catch (err) {
      // Recorded loudly on the finding as a MISSING factor (never as "no match");
      // it does not veto resolution via the remaining factors.
      searchMatchError = String(err);
    }
  }
  const dobEid = searchMatchEmplIds.length === 1 ? searchMatchEmplIds[0] : "";

  // Person Org name lookup — always; harvests every visible instance row.
  // keepNonHdh: retention applies to every department.
  const lookup = await lookupPersonInUcpath(
    page,
    { kind: "by-name", name: person.name },
    { keepNonHdh: true },
  );
  const nameRows = lookup.results.map(toInstanceRow);
  const candidateEids = Array.from(new Set(nameRows.map((r) => r.emplId).filter(Boolean)));

  // Identity factor 2b: S2 first-day vs UCPath Last Hire (±7d, i9-check gate).
  const hireDateGate: HireDateLookupOutcome | null = person.firstDay
    ? selectPersonLookupByHireDate(
        person.firstDay,
        lookup.results.map((r) => ({
          emplId: r.emplId,
          name: r.name,
          startDate: r.startDate,
          effectiveDate: r.effectiveDate,
        })),
      )
    : null;
  const hireEid = hireDateGate?.status === "found" ? hireDateGate.emplId : "";

  const conflict =
    dobEid && hireEid && dobEid !== hireEid
      ? `Search/Match (name+DOB) resolved ${dobEid} but hire-date gate resolved ${hireEid}`
      : "";

  let resolvedEmplId = "";
  const identityFactors: string[] = [];
  if (dobEid && hireEid && dobEid === hireEid) {
    resolvedEmplId = dobEid;
    identityFactors.push("name", "dob", "hire-date");
  } else if (dobEid && !conflict) {
    resolvedEmplId = dobEid;
    identityFactors.push("name", "dob");
  } else if (hireEid && !conflict) {
    resolvedEmplId = hireEid;
    identityFactors.push("name", "hire-date");
  } else if (!conflict && candidateEids.length === 1) {
    // Name-only single candidate — 1 factor; the orchestrator must flag, never auto-shred.
    resolvedEmplId = candidateEids[0];
    identityFactors.push("name");
  }

  const base = {
    key: person.key,
    name: person.name,
    identityFactors,
    resolvedEmplId,
    searchMatchEmplIds,
    nameLookupCandidateEids: candidateEids,
    hireDateGate,
    conflict,
    searchMatchError,
    error: "",
  };

  if (conflict) {
    return {
      ...base,
      rows: nameRows,
      anyActive: null,
      latestTerminationDate: "",
      fiveYearsElapsed: null,
      status: "ambiguous",
    };
  }

  if (!resolvedEmplId) {
    const status =
      candidateEids.length > 1 || hireDateGate?.status === "ambiguous" ? "ambiguous" : "not-found";
    return {
      ...base,
      rows: nameRows,
      anyActive: null,
      latestTerminationDate: "",
      fiveYearsElapsed: null,
      status,
    };
  }

  // Instance rows for the resolved EID; if the name search never surfaced this
  // EID (Search/Match hit under a different name rendering), read it by EID.
  let rows = nameRows.filter((r) => r.emplId === resolvedEmplId);
  if (rows.length === 0) {
    const byEid = await lookupPersonInUcpath(page, { kind: "by-eid", emplId: resolvedEmplId }, {
      keepNonHdh: true,
    });
    rows = byEid.results.map(toInstanceRow);
  }
  if (rows.length === 0) {
    throw new Error(
      `Empl ID ${resolvedEmplId} resolved for "${person.name}" but Person Org Summary returned no rows for it`,
    );
  }

  const anyActive = rows.some((r) => !rowIsInactive(r));
  if (anyActive) {
    return {
      ...base,
      rows,
      anyActive: true,
      latestTerminationDate: "",
      fiveYearsElapsed: false,
      status: "active",
    };
  }

  const termDates = rows
    .map((r) => ({ raw: r.terminationDate, parsed: parseUsDate(r.terminationDate) }))
    .filter((d) => d.parsed !== null) as Array<{ raw: string; parsed: Date }>;
  if (termDates.length === 0) {
    // Every row inactive but no parseable termination date — never shred on this.
    return {
      ...base,
      rows,
      anyActive: false,
      latestTerminationDate: "",
      fiveYearsElapsed: null,
      status: "unresolved-dates",
    };
  }

  termDates.sort((a, b) => b.parsed.getTime() - a.parsed.getTime());
  const latest = termDates[0];
  return {
    ...base,
    rows,
    anyActive: false,
    latestTerminationDate: latest.raw,
    fiveYearsElapsed: fiveYearsElapsedSince(latest.parsed, new Date()),
    status: "terminated",
  };
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: collect-ucpath-employment-status.ts <input.json> <output.json>",
    );
  }
  const people: PersonInput[] = JSON.parse(readFileSync(inputPath, "utf8"));
  for (const p of people) {
    if (!p.key || !p.name || !p.firstName || !p.lastName) {
      throw new Error(`Input person missing key/name/firstName/lastName: ${JSON.stringify(p)}`);
    }
  }

  const { browser, page } = await launchBrowser({ headless: true });
  const findings: PersonFinding[] = [];
  try {
    // Same-operation retry for transient Duo/SSO flakes (kernel logins get 3
    // attempts; ISS-005 first-attempt flake recovers on retry).
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        if (attempt > 1) {
          // A timed-out attempt can strand the page on a bare app-domain URL
          // that fools the warm-page reuse check into "already_logged_in" with
          // NO session cookies (proven this run: every later navigation bounced
          // to disco.php). Clear cookies so the retry runs a REAL login.
          await page.context().clearCookies();
          await page.goto("about:blank");
        }
        ok = await loginToUCPath(page);
        if (ok) {
          // Verify the session actually holds: a bounce to SSO discovery is the
          // signature of a false "already_logged_in".
          await page.goto(UCPATH_SMART_HR_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          if (/disco\.php|SSOService|Shibboleth|\bsso\b/i.test(page.url())) {
            console.log(
              `[shred-audit] login attempt ${attempt}: session bounced to SSO discovery — not authenticated`,
            );
            ok = false;
          }
        }
      } catch (err) {
        if (attempt === 4) throw err;
        console.log(`[shred-audit] UCPath login attempt ${attempt} threw: ${String(err).split("\n")[0]}`);
      }
      if (!ok) console.log(`[shred-audit] UCPath login attempt ${attempt} failed`);
    }
    if (!ok) throw new Error("UCPath authentication failed after 4 attempts");

    for (const person of people) {
      let finding: PersonFinding | null = null;
      // Re-run every negative once (2026-08-04 lesson) before recording it.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await checkPerson(page, person);
          finding = { ...result, attempts: attempt };
          // Retry negatives once, and retry when the DOB factor errored (transient
          // HR-Tasks flake) so the second pass can restore the missing factor.
          if (result.status !== "not-found" && !result.searchMatchError) break;
        } catch (err) {
          if (finding) {
            // A completed earlier attempt beats a crashed retry — keep it and
            // note the retry error without destroying real data.
            finding = { ...finding, attempts: attempt, error: `retry attempt ${attempt} threw: ${String(err)}` };
            break;
          }
          finding = {
            key: person.key,
            name: person.name,
            attempts: attempt,
            identityFactors: [],
            resolvedEmplId: "",
            searchMatchEmplIds: [],
            nameLookupCandidateEids: [],
            hireDateGate: null,
            conflict: "",
            searchMatchError: "",
            rows: [],
            anyActive: null,
            latestTerminationDate: "",
            fiveYearsElapsed: null,
            status: "error",
            error: String(err),
          };
        }
      }
      if (!finding) throw new Error(`No finding produced for "${person.name}"`);
      findings.push(finding);
      console.log(
        `[shred-audit] ${person.key} "${person.name}" → ${finding.status}` +
          (finding.resolvedEmplId ? ` (EID ${finding.resolvedEmplId})` : "") +
          (finding.latestTerminationDate ? ` term ${finding.latestTerminationDate}` : "") +
          (finding.fiveYearsElapsed !== null ? ` 5y=${finding.fiveYearsElapsed}` : ""),
      );
      writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2));
    }
  } finally {
    await browser?.close();
  }

  console.log(`[shred-audit] wrote ${findings.length} findings → ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
