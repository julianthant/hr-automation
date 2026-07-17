/**
 * The `i9-check` step — the whole of the I-9 Check workflow. One task = one
 * person from a scanned I-9 packet: resolve them in UCPath, re-match the
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
  type ActionHistoryIndex,
} from "../../services/matching/employee-action-history.js";
import {
  appendI9CheckTrackerRow,
  decideI9RetentionAction,
  type I9CheckTrackerRow,
} from "../../tracker/exports/i9-check-tracker.js";
import type { I9CheckMemberInput } from "./schema.js";

/** What the UCPath search concluded for one person. */
export interface I9CheckSearchOutcome {
  status: "found" | "not-found" | "ambiguous";
  emplId: string;
  matchedName: string;
  candidateCount: number;
}

type I9CheckCtx = Pick<
  Ctx<readonly string[], Record<string, unknown>>,
  "page" | "step" | "updateData" | "screenshot"
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
    section1Present: person.sourcePage ? `Yes — page ${person.sourcePage}` : "Missing",
    section2Present: person.section2Page ? `Yes — page ${person.section2Page}` : "Missing",
    ...(input.roster?.ppsEid ? { ppsEid: input.roster.ppsEid } : {}),
    ...(input.roster?.separationDate ? { separationDate: input.roster.separationDate } : {}),
  });

  // Resolve the reviewer name BEFORE the browser work — the spreadsheet row
  // needs it, and a missing TIMEKEEPER_NAME should fail legibly, not after a
  // Duo-authenticated search.
  const reviewerName = deps.reviewerName ?? getTimekeeperName();

  await ctx.step("i9-check", async () => {
    const page = await ctx.page("ucpath");

    // ── UCPath person search ──
    const outcome = await searchUcpathForPerson(page, input, deps);
    log.step(
      `[i9-check] UCPath search for "${person.name}" (record ${input.recordIndex}): ` +
      `${outcome.status}${outcome.emplId ? ` EID ${outcome.emplId}` : ""}` +
      `${outcome.status === "ambiguous" ? ` (${outcome.candidateCount} candidates)` : ""}`,
    );
    await ctx.screenshot({
      kind: "form",
      label: "i9-check-search-result",
      systems: ["ucpath"],
    });

    // ── Roster re-match BY EID (never by name here — the OCR stage already
    // did the name match; the daemon must not silently contradict it) ──
    const found = outcome.status === "found";
    let rosterRow;
    if (found && outcome.emplId) {
      const loadRoster = deps.loadRosterImpl ?? (() => loadEmployeeActionHistory());
      const index = await loadRoster();
      rosterRow = lookupActionHistoryRowByEmplId(outcome.emplId, index);
      if (rosterRow) {
        const xref = crossRefFromRow(rosterRow);
        ctx.updateData({
          ...(xref.ppsEid ? { ppsEid: xref.ppsEid } : {}),
          ...(xref.i9SeparationDate ? { separationDate: xref.i9SeparationDate } : {}),
        });
        log.step(
          `[i9-check] Roster re-match by EID ${outcome.emplId}: PPS ${xref.ppsEid ?? "—"}, ` +
          `separation ${xref.i9SeparationDate ?? "—"}`,
        );
      } else {
        log.warn(
          `[i9-check] EID ${outcome.emplId} ("${person.name}") is not on the Action History roster — ` +
          `no separation date available`,
        );
      }
    }

    // ── Retention decision + verdict stamp ──
    const rosterXref = rosterRow ? crossRefFromRow(rosterRow) : undefined;
    const decision = decideI9RetentionAction({
      found,
      ambiguous: outcome.status === "ambiguous",
      ambiguousCandidateCount: outcome.candidateCount,
      separationDate: rosterXref?.i9SeparationDate,
      hasRosterRow: !!rosterRow,
      emplId: outcome.emplId || undefined,
      today: deps.today ?? new Date(),
    });

    ctx.updateData({
      // The chip (`i9CheckStatusExtensions.secondaryTag`) keys on
      // data.ucpathFound — an ambiguous outcome deliberately leaves it unset,
      // so the row shows no definitive chip.
      ...(outcome.status !== "ambiguous"
        ? { ucpathFound: found ? "true" : "false" }
        : {}),
      ucpathFoundLabel: decision.foundLabel,
      ...(outcome.emplId ? { eid: outcome.emplId } : {}),
      ...(outcome.matchedName ? { matchedName: outcome.matchedName } : {}),
      i9RetentionAction: decision.action,
      ...(decision.note ? { i9RetentionNote: decision.note } : {}),
    });

    // ── Master tracker append ──
    // A found person's PPS/separation come from the EID re-match; a not-found
    // person keeps the OCR stage's name-match seed (mirrors the operator's
    // manual sheet, where not-found people still carry a roster PPS EID).
    const seed = input.roster;
    const row: I9CheckTrackerRow = {
      employeeName: person.name,
      ppsEid: found
        ? (rosterXref?.ppsEidPadded ?? rosterXref?.ppsEid ?? "")
        : (seed?.ppsEidPadded ?? seed?.ppsEid ?? ""),
      ucpathEmplId: found ? outcome.emplId : "",
      hireDate: person.hireDate ?? "",
      separationDate: found
        ? (rosterXref?.i9SeparationDate ?? "")
        : (seed?.separationDate ?? ""),
      foundInUcpath: decision.foundLabel,
      action: decision.action,
      reviewerName,
      notes: decision.note,
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
 * Run the right UCPath search for what the packet gave us: SSN/DOB present →
 * the HR-Tasks person search (`searchPerson`, the duplicate-person gate
 * onboarding uses); name only (orphan Section 2 / unreadable identifiers) →
 * the Person Org Summary name lookup. Never guesses between multiple
 * candidates — ambiguity is returned, not resolved.
 */
async function searchUcpathForPerson(
  page: Awaited<ReturnType<I9CheckCtx["page"]>>,
  input: I9CheckMemberInput,
  deps: I9CheckDeps,
): Promise<I9CheckSearchOutcome> {
  const { person } = input;
  const hasIdentifier = Boolean(person.ssn || person.dob);

  if (hasIdentifier && person.firstName && person.lastName) {
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

  // Name-only lookup. keepNonHdh — retention applies to every department, so
  // the HDH filter must not hide a real match.
  const lookup = deps.lookupImpl ?? lookupPersonInUcpath;
  const result = await lookup(page, { kind: "by-name", name: person.name }, { keepNonHdh: true });
  const { selection } = result;
  if (selection.status === "ambiguous") {
    return {
      status: "ambiguous",
      emplId: "",
      matchedName: "",
      candidateCount: selection.candidateEids.length,
    };
  }
  if (selection.status === "resolved" && selection.selected) {
    return {
      status: "found",
      emplId: selection.selected.emplId,
      matchedName: selection.selected.name,
      candidateCount: 1,
    };
  }
  return { status: "not-found", emplId: "", matchedName: "", candidateCount: 0 };
}
