/**
 * I-9 check result fan-back — the separations half of the "Run I-9 Check"
 * operation flow.
 *
 * An i9 OCR run launched from the separations panel is delegated under a
 * `separations` operation coordinator row (one per uploaded PDF). The i9 form
 * spec has NO approve flow (`completeDelegatedRun`), so when the run completes
 * — right after the per-record UCPath person-match enrichment — the prepare
 * route calls `emitI9CheckResultRows` to fan the finished report back into the
 * separations queue: one DISPLAY `operation-member` row per checked person
 * (name + matched EID, `done` when UCPath definitively answered found/not
 * found, `failed` when the search couldn't answer), nested under the
 * coordinator. The found/not-found chip renders via the separations
 * `statusExtensions.secondaryTag` keyed on `data.ucpathFound`
 * (`src/domain/separations-status.ts`).
 *
 * These are display rows, not daemon tasks — there is nothing to run; the
 * person-match children already did the work under the OCR run.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { appendLogEntry, emitTrackerRow } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { buildTraceId, tracePrefix } from "../../../domain/queue-trace-id.js";
import { log } from "../../../utils/log.js";
import {
  I9PreviewRecordSchema,
  buildI9DisplayName,
  type I9PreviewRecord,
} from "../../../services/ocr/forms/i9.js";

const I9RecordsSchema = z.array(I9PreviewRecordSchema);

/** One log line for a member row (emitted against that row's own runId). */
export interface I9CheckMemberLog {
  level: "step" | "success" | "warn" | "error";
  message: string;
}

/** One fanned-back member row, derived purely from an i9 preview record. */
export interface I9CheckMember {
  /** Index of the source record in the OCR run's `records` array. */
  index: number;
  /** Display name ("Last, First M"), or a page-N placeholder when unreadable. */
  name: string;
  /** `done` = UCPath definitively answered; `failed` = the check never answered. */
  status: "done" | "failed";
  /** Matched UCPath Empl ID (found records only). */
  emplId?: string;
  /** Matched UCPath name (found records only). */
  matchedName?: string;
  /** "true" | "false" when UCPath answered — drives the found/not-found tag. */
  ucpathFound?: "true" | "false";
  /** Trace id of the person-match child that produced the verdict. */
  personMatchTraceId?: string;
  /** Legible reason for a failed check. */
  error?: string;
  /**
   * The row's operator log. A member row has NO daemon task — the search ran
   * under the OCR run's person-match child — so nothing would otherwise log
   * against its runId and the log panel rendered EMPTY (live 2026-07-13). These
   * lines are emitted against the member's own (workflow, itemId, runId), which
   * is the key `selectLogsForRun` reads.
   */
  logs: I9CheckMemberLog[];
}

/**
 * The log an operator needs to JUDGE a verdict — above all, the criteria the
 * verdict rests on. A UCPath "not found" is only as good as the OCR that fed
 * it: a single misread SSN digit or DOB year returns "no results" that is
 * indistinguishable from a real absence (live 2026-07-13: 17 of 29 scanned
 * Section 1s had at least one wrong field). So every row states what was
 * searched, never just the answer.
 *
 * The SSN is NEVER logged — only whether one was supplied.
 */
function buildMemberLogs(rec: I9PreviewRecord, member: I9CheckMember): I9CheckMemberLog[] {
  const logs: I9CheckMemberLog[] = [];
  const dob = (rec.dateOfBirth ?? "").trim();
  const hasSsn = (rec.ssn ?? "").trim().length > 0;
  logs.push({
    level: "step",
    message:
      `I-9 Section 1 read from page ${rec.sourcePage} — name "${member.name}"`
      + (rec.extractedBy ? ` (extracted by ${rec.extractedBy})` : ""),
  });

  // The corroboration line is the one that tells the operator whether to
  // believe any of this.
  if (rec.corroboration === "confirmed") {
    logs.push({
      level: "step",
      message: "Cross-checked against the employer's Section 2 sheet — the two readings agree.",
    });
  } else if (rec.corroboration === "disputed") {
    logs.push({
      level: "warn",
      message:
        `DISPUTED by the employer's Section 2 sheet on: ${rec.disputedFields.join(", ")}. `
        + `The disputed field(s) were NOT used to search UCPath.`,
    });
  } else if (rec.formKind === "i9") {
    logs.push({
      level: "step",
      message: "No Section 2 sheet found for this person — the read could not be cross-checked.",
    });
  }
  if (rec.illegible.length > 0) {
    logs.push({
      level: "warn",
      message:
        `Not legible on the scan, so left EMPTY rather than guessed: ${rec.illegible.join(", ")}. `
        + `A guessed digit would have searched UCPath for the wrong person.`,
    });
  }

  const searchedWith = (f: string) => !rec.disputedFields.includes(f) && !rec.illegible.includes(f);
  logs.push({
    level: "step",
    message:
      `UCPath person search criteria: name "${member.name}", `
      + `DOB ${dob && searchedWith("dateOfBirth") ? dob : "(not used)"}, `
      + `SSN ${hasSsn && searchedWith("ssn") ? "supplied" : "(not used)"} `
      + `— a wrong digit in ANY of these returns "no results", which reads the same as a real absence.`,
  });
  if (member.personMatchTraceId) {
    logs.push({
      level: "step",
      message: `Searched by person-match child ${member.personMatchTraceId} (its own row carries the full page-by-page log).`,
    });
  }
  for (const note of rec.notes) logs.push({ level: "step", message: `OCR note: ${note}` });
  for (const warning of rec.warnings) logs.push({ level: "warn", message: `OCR warning: ${warning}` });
  if (rec.originallyMissing.length > 0) {
    logs.push({
      level: "warn",
      message: `Section 1 fields missing on the scan and back-filled: ${rec.originallyMissing.join(", ")}`,
    });
  }

  if (member.ucpathFound === "true") {
    logs.push({
      level: "success",
      message:
        `Found in UCPath — Empl ID ${member.emplId ?? "(not read)"}`
        + (member.matchedName ? ` (${member.matchedName})` : ""),
    });
    if (member.matchedName && member.matchedName.trim() && member.name) {
      logs.push({
        level: "step",
        message: `UCPath's name for this person is "${member.matchedName}" — compare it against the paper before acting.`,
      });
    }
  } else if (member.ucpathFound === "false") {
    logs.push({
      level: "warn",
      message:
        `NOT found in UCPath — the search returned no results for the criteria above. `
        + `Confirm the extracted name/DOB/SSN against page ${rec.sourcePage} before treating this as a real absence.`,
    });
  } else {
    logs.push({ level: "error", message: member.error ?? "UCPath person match did not answer." });
  }
  return logs;
}

/**
 * Project the run's enriched records onto member rows. Pure — unit-tested.
 *
 * Skips only the expected filler pages of a scanned packet (non-Section-1
 * pages with no identity and no attempted match). Every page that named a
 * person — or SHOULD have (an i9-classified page with an unreadable
 * Section 1) — yields a row, so the operator sees a failed check rather than
 * a silently missing person (fail loud).
 */
export function buildI9CheckMembers(records: I9PreviewRecord[]): I9CheckMember[] {
  const members: I9CheckMember[] = [];
  for (let index = 0; index < records.length; index++) {
    const rec = records[index];
    const name = (rec.name ?? "").trim() || buildI9DisplayName(rec);

    // An orphan Section 2 — the employer verified this person, but their
    // Section 1 page is missing from the packet, so they were never checked.
    // A missing document is a finding, not filler: surface it as a failed row.
    if (rec.orphanSection2) {
      const orphan: I9CheckMember = {
        index,
        name: rec.section2Name ?? `Page ${rec.sourcePage} — Section 2, no Section 1`,
        status: "failed",
        error:
          `Section 2 is in the packet but the Section 1 page is NOT — this person was never checked `
          + `against UCPath. Locate the missing Section 1 page (Section 2 is on page ${rec.sourcePage}).`,
        logs: [],
      };
      orphan.logs = buildMemberLogs(rec, orphan);
      members.push(orphan);
      continue;
    }

    if (rec.formKind !== "i9" && !name && !rec.personMatchStatus) {
      // Expected filler page (Section 2 / Lists of Acceptable Documents /
      // blank) — not a person, not an error.
      continue;
    }
    const answered = rec.ucpathFound === true || rec.ucpathFound === false;

    // A NOT-FOUND is only as good as the fields it was searched with. When the
    // employer's Section 2 contradicts our read, or the model could not read a
    // field at all, "no results" tells us nothing — UCPath answers "no results"
    // for a wrong digit exactly as it does for a person who truly isn't there.
    // Reporting that as a confident "Not in UCPath" is precisely the lie this
    // pipeline must never tell, so it becomes a loud, actionable failure.
    // (A FOUND is self-validating — UCPath matched a real person — so a
    // dispute never downgrades it; the warning still rides the row.)
    const untrustworthy = [...rec.disputedFields, ...rec.illegible];
    const notFoundOnBadData = rec.ucpathFound === false && untrustworthy.length > 0;

    const member: I9CheckMember = {
      index,
      name: name || `Page ${rec.sourcePage} — unreadable Section 1`,
      status: answered && !notFoundOnBadData ? "done" : "failed",
      logs: [],
    };
    if (rec.personMatchTraceId) member.personMatchTraceId = rec.personMatchTraceId;
    if (notFoundOnBadData) {
      member.error =
        `UCPath returned no match, but this record's ${untrustworthy.join(" + ")} could not be trusted `
        + `(${rec.disputedFields.length > 0 ? "contradicted by the employer's Section 2" : "not legible on the scan"}), `
        + `so "not found" is NOT a reliable answer. Verify the fields against page ${rec.sourcePage} and re-run.`;
    } else if (answered) {
      member.ucpathFound = rec.ucpathFound ? "true" : "false";
      if (rec.ucpathFound && rec.matchedEmplId) member.emplId = rec.matchedEmplId;
      if (rec.ucpathFound && rec.matchedName) member.matchedName = rec.matchedName;
    } else {
      member.error =
        rec.warnings.length > 0
          ? rec.warnings.join("; ")
          : rec.personMatchStatus === "failed"
            ? "UCPath person match failed — found/not-found unknown"
            : "UCPath person match did not run";
    }
    member.logs = buildMemberLogs(rec, member);
    members.push(member);
  }
  return members;
}

export interface EmitI9CheckResultRowsArgs {
  /** OCR session id — resolves the finished run's records row. */
  sessionId: string;
  /** The completed OCR run's id. */
  ocrRunId: string;
  /** The separations operation coordinator the members nest under. */
  operation: {
    workflow: string;
    runId: string;
    /** Coordinator trace id — members compose its prefix with their own tail. */
    traceId: string;
  };
  trackerDir?: string | undefined;
}

export interface I9CheckFanBackSummary {
  emitted: number;
  found: number;
  notFound: number;
  failed: number;
}

/**
 * Read the completed i9 OCR run's records and emit one `operation-member`
 * display row per checked person into the coordinator's workflow panel.
 *
 * Throws (fail loud) when the finished run's records can't be found or don't
 * parse — the caller surfaces that on the coordinator row instead of leaving a
 * silently empty operation that reads as "checked, nothing found".
 */
export function emitI9CheckResultRows(args: EmitI9CheckResultRowsArgs): I9CheckFanBackSummary {
  const { sessionId, ocrRunId, operation, trackerDir } = args;
  const row = findLatestEntryForPredicate({
    workflow: "ocr",
    ...(trackerDir !== undefined ? { trackerDir } : {}),
    lookbackDays: 2,
    predicate: (e) =>
      e.id === sessionId && e.runId === ocrRunId && typeof e.data?.records === "string",
  });
  if (!row) {
    throw new Error(
      `I-9 check fan-back: no records row found for completed OCR run ${ocrRunId} (session ${sessionId}) — cannot emit separations results`,
    );
  }
  const parsed = I9RecordsSchema.safeParse(JSON.parse(row.data!.records));
  if (!parsed.success) {
    throw new Error(
      `I-9 check fan-back: records on OCR run ${ocrRunId} (session ${sessionId}) failed to parse: ${parsed.error.message}`,
    );
  }

  const members = buildI9CheckMembers(parsed.data);
  const rootPrefix = tracePrefix(operation.traceId);
  const now = new Date();
  let found = 0;
  let notFound = 0;
  let failed = 0;
  for (const member of members) {
    if (member.ucpathFound === "true") found += 1;
    else if (member.ucpathFound === "false") notFound += 1;
    else failed += 1;
    const memberRunId = randomUUID();
    const memberItemId = `i9-check-${sessionId}-r${member.index}`;
    emitTrackerRow(
      {
        workflow: operation.workflow,
        timestamp: new Date().toISOString(),
        id: memberItemId,
        runId: memberRunId,
        parentRunId: operation.runId,
        status: member.status,
        step: "i9-check",
        data: {
          archetype: "operation-member",
          queueRowKind: "person",
          i9Check: "true",
          // No daemon task backs this row — the person-match child that produced
          // it ran under the OCR run. Suppresses retry/cancel/bump in the queue
          // footer (a separations retry would start a REAL termination run —
          // see `isDisplayOnlyRow`); delete stays available.
          displayOnly: "true",
          name: member.name,
          ...(member.emplId ? { emplId: member.emplId } : {}),
          ...(member.matchedName ? { matchedName: member.matchedName } : {}),
          ...(member.ucpathFound ? { ucpathFound: member.ucpathFound } : {}),
          ...(member.personMatchTraceId ? { personMatchTraceId: member.personMatchTraceId } : {}),
          ocrSessionId: sessionId,
          ocrRunId,
          __id: memberItemId,
          __subject: member.name,
          __subjectKind: "person",
          __traceId: buildTraceId({
            code: "se",
            runId: memberRunId,
            at: now,
            rootPrefix,
          }),
        },
        ...(member.error ? { error: member.error } : {}),
      },
      trackerDir,
    );
    // Give the row its own log. `selectLogsForRun` keys on
    // (workflow, tracker_date, item_id, run_id) — nothing else ever writes
    // against a member's runId, which is why these rows opened to an EMPTY log
    // panel while the real search log sat under `person-match`/`ocr`.
    for (const line of member.logs) {
      appendLogEntry(
        {
          workflow: operation.workflow,
          itemId: memberItemId,
          runId: memberRunId,
          level: line.level,
          message: line.message,
          ts: new Date().toISOString(),
        },
        trackerDir,
      );
    }
  }
  log.success(
    `[i9-check] separations results fanned back — ${members.length} row(s): ${found} found / ${notFound} not found / ${failed} failed (session ${sessionId})`,
  );
  return { emitted: members.length, found, notFound, failed };
}
