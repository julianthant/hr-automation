/**
 * The `i9-check` member handler — three kernel steps: person-match →
 * optional person-lookup (hire-date corroborated) → roster-match. One task =
 * one person from a scanned I-9 packet: resolve them in UCPath, re-match the
 * Action History roster by the resolved EID, stamp the verdict on the row,
 * and append one row to the master I-9 retention tracker.
 *
 * STRUCTURAL SAFETY: this module touches only the UCPath page and read-only
 * search primitives — it imports no kuali-* / ucpath-transaction / kronos
 * modules, so an i9-check task cannot mutate any live HR system. Pinned by
 * `tests/unit/architecture/i9-check-import-guard.test.ts`.
 */
import { log } from "../../utils/log.js";
import { getTimekeeperName, PATHS } from "../../config.js";
import type { Ctx } from "../../core/kernel/types.js";
import { searchPerson } from "../../systems/ucpath/navigate.js";
import { lookupPersonInUcpath } from "../person-lookup/lookup.js";
import {
  crossRefFromRow,
  loadEmployeeActionHistory,
  lookupActionHistoryRowByEmplId,
  lookupActionHistoryRowByPpsId,
  type ActionHistoryIndex,
  type ActionHistoryRow,
} from "../../services/matching/employee-action-history.js";
import {
  appendI9CheckTrackerRow,
  decideI9RetentionAction,
  type I9CheckTrackerRow,
} from "../../tracker/exports/i9-check-tracker.js";
import type { I9CheckMemberInput } from "./schema.js";
import {
  selectPersonLookupByHireDate,
  type HireDateLookupOutcome,
} from "./select-by-hire-date.js";

/** What UCPath resolution concluded for one person (after match + optional lookup). */
export interface I9CheckSearchOutcome {
  status: "found" | "not-found" | "ambiguous";
  emplId: string;
  matchedName: string;
  candidateCount: number;
  /** Why the outcome is ambiguous — drives the retention review note. */
  ambiguousReason?: "multiple-candidates" | "missing-hire-date" | "multiple-hire-date-matches";
}

const I9_CHECK_STEPS = ["person-match", "person-lookup", "roster-match"] as const;

type I9CheckCtx = Pick<
  Ctx<typeof I9_CHECK_STEPS, Record<string, unknown>>,
  "page" | "step" | "updateData" | "screenshot" | "skipStep"
>;

export interface I9CheckDeps {
  searchImpl?: typeof searchPerson;
  lookupImpl?: typeof lookupPersonInUcpath;
  loadRosterImpl?: () => Promise<ActionHistoryIndex>;
  appendRowImpl?: typeof appendI9CheckTrackerRow;
  trackerPath?: string;
  reviewerName?: string;
  today?: Date;
}

export async function runI9CheckMember(
  ctx: I9CheckCtx,
  input: I9CheckMemberInput,
  deps: I9CheckDeps = {},
): Promise<void> {
  const { person } = input;

  // Stamp the display data up front so the member row is legible from the
  // first running emit (the pending row's seed does not survive re-emits).
  ctx.updateData({
    name: person.name,
    i9Check: "true",
    i9HireDate: person.hireDate ?? "",
    // Slot both ID columns from the first emit so the grid never drops EID
    // while person-match is still running (PPS may already be OCR-seeded).
    eid: "",
    ppsEid: input.roster?.ppsEid ?? "",
    separationDate: input.roster?.separationDate ?? "",
    section1Present: person.sourcePage ? `Yes — page ${person.sourcePage}` : "Missing",
    section2Present: person.section2Page ? `Yes — page ${person.section2Page}` : "Missing",
  });

  // Resolve the reviewer name BEFORE the browser work — the spreadsheet row
  // needs it, and a missing TIMEKEEPER_NAME should fail legibly, not after a
  // Duo-authenticated search.
  const reviewerName = deps.reviewerName ?? getTimekeeperName();

  let outcome: I9CheckSearchOutcome = {
    status: "not-found",
    emplId: "",
    matchedName: "",
    candidateCount: 0,
  };

  // ── 1. Person match (mandatory) ──
  await ctx.step("person-match", async () => {
    const page = await ctx.page("ucpath");
    outcome = await runPersonMatch(page, input, deps);
    ctx.updateData({
      personMatchFound: outcome.status === "found" ? "true" : "false",
      ...(outcome.emplId ? { personMatchEmplId: outcome.emplId } : {}),
    });
    log.step(
      `[i9-check] person-match for "${person.name}" (record ${input.recordIndex}): ` +
      `${outcome.status}${outcome.emplId ? ` EID ${outcome.emplId}` : ""}` +
      `${outcome.status === "ambiguous" ? ` (${outcome.candidateCount} candidates)` : ""}`,
    );
    await ctx.screenshot({
      kind: "form",
      label: "i9-check-person-match",
      systems: ["ucpath"],
    });
  });

  // ── 2. Person lookup (optional — only when match did not resolve an EID) ──
  if (outcome.status === "found" && outcome.emplId) {
    ctx.skipStep("person-lookup");
  } else {
    await ctx.step("person-lookup", async () => {
      const page = await ctx.page("ucpath");
      outcome = await runPersonLookup(page, input, deps);
      ctx.updateData({
        personLookupStatus: outcome.status,
        ...(outcome.emplId ? { personLookupEmplId: outcome.emplId } : {}),
      });
      log.step(
        `[i9-check] person-lookup for "${person.name}" (record ${input.recordIndex}): ` +
        `${outcome.status}${outcome.emplId ? ` EID ${outcome.emplId}` : ""}` +
        `${outcome.ambiguousReason ? ` (${outcome.ambiguousReason})` : ""}` +
        `${outcome.status === "ambiguous" ? ` · ${outcome.candidateCount} candidates` : ""}`,
      );
      await ctx.screenshot({
        kind: "form",
        label: "i9-check-person-lookup",
        systems: ["ucpath"],
      });
    });
  }

  // ── 3. Roster rematch + retention tracker (mandatory) ──
  await ctx.step("roster-match", async () => {
    const found = outcome.status === "found";
    const seed = input.roster;
    let rosterRow: ActionHistoryRow | undefined;
    let rematchHow: "empl-id" | "pps" | undefined;
    if (found && outcome.emplId) {
      const loadRoster = deps.loadRosterImpl ?? (() => loadEmployeeActionHistory());
      const index = await loadRoster();
      rosterRow = lookupActionHistoryRowByEmplId(outcome.emplId, index);
      if (rosterRow) {
        rematchHow = "empl-id";
      } else {
        // Empl ID miss → try the OCR-seeded PPS (often 5 digits after zero-strip
        // from "Employee PPS ID Current"). Name fallback stays forbidden here.
        const ppsSeed = seed?.ppsEid ?? seed?.ppsEidPadded;
        if (ppsSeed) {
          rosterRow = lookupActionHistoryRowByPpsId(ppsSeed, index);
          if (rosterRow) rematchHow = "pps";
        }
      }
      if (rosterRow) {
        const xref = crossRefFromRow(rosterRow);
        log.step(
          rematchHow === "pps"
            ? `[i9-check] Roster re-match by OCR PPS ${seed?.ppsEid ?? seed?.ppsEidPadded} ` +
              `(EID ${outcome.emplId} not on roster): PPS ${xref.ppsEid ?? "—"}, ` +
              `separation ${xref.i9SeparationDate ?? "—"}`
            : `[i9-check] Roster re-match by EID ${outcome.emplId}: PPS ${xref.ppsEid ?? "—"}, ` +
              `separation ${xref.i9SeparationDate ?? "—"}`,
        );
      } else {
        log.warn(
          `[i9-check] EID ${outcome.emplId} ("${person.name}") is not on the Action History roster — ` +
          `no separation date available` +
          (seed?.ppsEid ? ` (OCR PPS seed ${seed.ppsEid} also missed)` : ""),
        );
      }
    }

    const rosterXref = rosterRow ? crossRefFromRow(rosterRow) : undefined;
    // Prefer the EID/PPS rematch; else keep the OCR name-match seed (5-digit
    // PPS + sep date). Always stamp both keys so the detail grid shows them.
    const ppsDisplay = rosterXref?.ppsEid ?? seed?.ppsEid ?? "";
    const sepDisplay = rosterXref?.i9SeparationDate ?? seed?.separationDate ?? "";

    const decision = decideI9RetentionAction({
      found,
      ambiguous: outcome.status === "ambiguous",
      ambiguousCandidateCount: outcome.candidateCount,
      separationDate: rosterXref?.i9SeparationDate ?? seed?.separationDate,
      // A real rematch OR an OCR name-match seed that already carried a sep
      // date — either lets retention run. A PPS-only seed without a date
      // still shows on the grid but does not pretend we have a roster row.
      hasRosterRow: !!rosterRow || Boolean(seed?.separationDate),
      emplId: outcome.emplId || undefined,
      today: deps.today ?? new Date(),
    });

    // Override the generic ambiguous note when the hire-date gate is why we
    // refused to accept a Person Org name hit.
    let note = decision.note;
    if (outcome.status === "ambiguous" && outcome.ambiguousReason === "missing-hire-date") {
      note =
        "Person Org name match cannot be corroborated — I-9 hire date missing; review manually.";
    } else if (
      outcome.status === "ambiguous" &&
      outcome.ambiguousReason === "multiple-hire-date-matches"
    ) {
      note =
        "Multiple Person Org candidates match the I-9 hire date (±7 days) — review manually.";
    }

    ctx.updateData({
      // The chip (`i9CheckStatusExtensions.secondaryTag`) keys on
      // data.ucpathFound — an ambiguous outcome deliberately leaves it unset,
      // so the row shows no definitive chip.
      ...(outcome.status !== "ambiguous"
        ? { ucpathFound: found ? "true" : "false" }
        : {}),
      ucpathFoundLabel: decision.foundLabel,
      // Always stamp both IDs so the detail grid shows EID + PPS ID side by side.
      eid: outcome.emplId || "",
      ...(outcome.matchedName ? { matchedName: outcome.matchedName } : {}),
      ppsEid: ppsDisplay,
      separationDate: sepDisplay,
      i9RetentionAction: decision.action,
      ...(note ? { i9RetentionNote: note } : {}),
    });

    // Spreadsheet PPS/separation: rematch wins; otherwise the OCR seed
    // (mirrors the operator's manual sheet for not-found AND for found-but-
    // not-on-roster-by-EID people who still have a name-match PPS).
    const row: I9CheckTrackerRow = {
      employeeName: person.name,
      ppsEid:
        rosterXref?.ppsEidPadded
        ?? rosterXref?.ppsEid
        ?? seed?.ppsEidPadded
        ?? seed?.ppsEid
        ?? "",
      ucpathEmplId: found ? outcome.emplId : "",
      hireDate: person.hireDate ?? "",
      separationDate: rosterXref?.i9SeparationDate ?? seed?.separationDate ?? "",
      foundInUcpath: decision.foundLabel,
      action: decision.action,
      reviewerName,
      notes: note,
    };
    const trackerPath = deps.trackerPath ?? PATHS.i9CheckTrackerPath;
    const appendRow = deps.appendRowImpl ?? appendI9CheckTrackerRow;
    await appendRow(trackerPath, row);
    log.success(
      `[i9-check] "${person.name}" → ${decision.foundLabel}` +
      `${decision.action ? ` · ${decision.action}` : ""} — appended to ${trackerPath}`,
    );
  });
}

/**
 * HR-Tasks person search (person-match). Requires SSN or DOB + first/last —
 * without identifiers the outcome is not-found so the optional lookup path runs.
 */
async function runPersonMatch(
  page: Awaited<ReturnType<I9CheckCtx["page"]>>,
  input: I9CheckMemberInput,
  deps: I9CheckDeps,
): Promise<I9CheckSearchOutcome> {
  const { person } = input;
  const hasIdentifier = Boolean(person.ssn || person.dob);

  if (!hasIdentifier || !person.firstName || !person.lastName) {
    const missing = [
      !hasIdentifier ? "SSN/DOB" : null,
      !person.firstName ? "firstName" : null,
      !person.lastName ? "lastName" : null,
    ].filter(Boolean);
    log.step(
      `[i9-check] person-match skipped for "${person.name}" — missing ${missing.join(", ")}; ` +
      `treating as not-found so person-lookup can run`,
    );
    return { status: "not-found", emplId: "", matchedName: "", candidateCount: 0 };
  }

  const search = deps.searchImpl ?? searchPerson;
  const result = await search(
    page,
    person.ssn ?? "",
    person.firstName,
    person.lastName,
    person.dob ?? "",
  );
  const match = result.matches?.[0];
  return {
    status: result.found ? "found" : "not-found",
    emplId: match?.emplId ?? "",
    matchedName: match
      ? [match.firstName, match.lastName].filter(Boolean).join(" ")
      : "",
    candidateCount: result.matches?.length ?? 0,
  };
}

/**
 * Person Org name lookup + I-9 hire-date corroboration (±7 days vs Last Hire).
 */
async function runPersonLookup(
  page: Awaited<ReturnType<I9CheckCtx["page"]>>,
  input: I9CheckMemberInput,
  deps: I9CheckDeps,
): Promise<I9CheckSearchOutcome> {
  const { person } = input;
  const lookup = deps.lookupImpl ?? lookupPersonInUcpath;
  // keepNonHdh — retention applies to every department, so the HDH filter
  // must not hide a real match.
  const result = await lookup(
    page,
    { kind: "by-name", name: person.name },
    { keepNonHdh: true },
  );

  const hireOutcome: HireDateLookupOutcome = selectPersonLookupByHireDate(
    person.hireDate,
    result.results,
  );

  if (hireOutcome.status === "found") {
    return {
      status: "found",
      emplId: hireOutcome.emplId,
      matchedName: hireOutcome.matchedName,
      candidateCount: 1,
    };
  }
  if (hireOutcome.status === "not-found") {
    return {
      status: "not-found",
      emplId: "",
      matchedName: "",
      candidateCount: hireOutcome.candidateCount,
    };
  }
  return {
    status: "ambiguous",
    emplId: "",
    matchedName: "",
    candidateCount: hireOutcome.candidateCount,
    ambiguousReason: hireOutcome.reason,
  };
}
