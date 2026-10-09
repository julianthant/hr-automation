/**
 * Fan out a live I-9 Check operation from Claude-extracted records
 * (`data/i9/extracted/merged.records.json` or a per-PDF `*.records.json`),
 * skipping the vision OCR pass.
 *
 *   npx tsx --env-file=.env scripts/run-i9-check-from-extracted.ts \
 *     data/i9/extracted/merged.records.json [--workers N]
 *
 * Writes into the live `.tracker/` (same surface the dashboard is watching),
 * enriches via the i9 form-spec roster NAME match, then calls the production
 * `enqueueI9CheckMemberTasks` path so real i9-check daemons claim the work.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { buildTraceId } from "../src/domain/queue-trace-id.js";
import {
  buildI9DisplayName,
  buildI9Checks,
  i9SheetName,
  isI9Section1,
  normalizeI9Dob,
  normalizeI9Ssn,
  type I9PreviewRecord,
} from "../src/services/ocr/forms/i9.js";
import { enqueueI9CheckMemberTasks } from "../src/tracker/dashboard/ocr/i9-check-results.js";
import { emitTrackerRow } from "../src/tracker/jsonl.js";
import { log } from "../src/utils/log.js";

type MergedSourcePage = {
  current: number;
  section1Pdf: string | null;
  section1Page: number | null;
  section2Pdf: string | null;
  section2Page: number | null;
  ssnPdf: string | null;
  ssnPage: number | null;
};

type ExtractedRecord = {
  formKind: string;
  sourcePage: number | MergedSourcePage;
  sourcePdf?: string;
  lastName?: string | null;
  firstName?: string | null;
  middleInitial?: string | null;
  dateOfBirth?: string | null;
  ssn?: string | null;
  hireDate?: string | null;
  documentType?: string;
  originallyMissing?: string[];
  illegible?: string[];
  notes?: string[];
};

function pageCurrent(sp: number | MergedSourcePage): number {
  return typeof sp === "number" ? sp : sp.current;
}

function pageLinks(sp: number | MergedSourcePage): MergedSourcePage | null {
  return typeof sp === "number" ? null : sp;
}

function ssnDigits(v: string | null | undefined): string | null {
  return normalizeI9Ssn(v) ?? null;
}

function findByPdfPage(
  records: ExtractedRecord[],
  pdf: string | null,
  page: number | null,
): ExtractedRecord | undefined {
  if (!pdf || page == null) return undefined;
  return records.find(
    (r) => (r.sourcePdf ?? "") === pdf && pageCurrent(r.sourcePage) === page,
  );
}

/** Preserve hand-verified merged pairing; do NOT re-run name pairing. */
function toPreviewRecords(raw: ExtractedRecord[]): I9PreviewRecord[] {
  const previews: I9PreviewRecord[] = raw.map((r) => {
    const links = pageLinks(r.sourcePage);
    const sourcePage = pageCurrent(r.sourcePage);
    const pdfNote = r.sourcePdf ? `sourcePdf=${r.sourcePdf}` : null;
    const rec: I9PreviewRecord = {
      formKind: (r.formKind as I9PreviewRecord["formKind"]) ?? "unknown",
      sourcePage,
      lastName: r.lastName ?? null,
      firstName: r.firstName ?? null,
      middleInitial: r.middleInitial ?? null,
      dateOfBirth: r.dateOfBirth ?? null,
      ssn: r.ssn ?? null,
      hireDate: r.hireDate ?? null,
      documentType: (r.documentType as "expected" | "unknown") ?? "expected",
      originallyMissing: r.originallyMissing ?? [],
      illegible: r.illegible ?? [],
      notes: [...(r.notes ?? []), ...(pdfNote ? [pdfNote] : [])],
      name: "",
      matchState: "extracted",
      selected: true,
      warnings: [],
      checks: [],
      corroboration: "unavailable",
      disputedFields: [],
      orphanSection2: false,
      ...(links?.section1Page != null ? { section1Page: links.section1Page } : {}),
      ...(links?.section2Page != null ? { section2Page: links.section2Page } : {}),
      ...(links?.ssnPage != null ? { ssnPage: links.ssnPage } : {}),
    };
    rec.name = buildI9DisplayName(rec);
    return rec;
  });

  for (let i = 0; i < previews.length; i++) {
    const rec = previews[i]!;
    const rawRec = raw[i]!;
    const links = pageLinks(rawRec.sourcePage);

    if (isI9Section1(rec)) {
      if (!links || (links.section2Page == null && links.ssnPage == null)) {
        rec.corroboration = "unavailable";
        continue;
      }
      const disputed: string[] = [];
      const sheet = findByPdfPage(raw, links.section2Pdf, links.section2Page);
      const ssnSheet = findByPdfPage(raw, links.ssnPdf, links.ssnPage);
      for (const [label, s] of [
        ["Section 2", sheet],
        ["SSN sheet", ssnSheet],
      ] as const) {
        if (!s) continue;
        const ours = ssnDigits(rec.ssn);
        const theirs = ssnDigits(s.ssn);
        if (ours && theirs && ours !== theirs && !disputed.includes("ssn")) {
          disputed.push("ssn");
          rec.warnings.push(
            `SSN disagrees with the employer's ${label}: Section 1 vs ${label} digits differ — SSN will NOT be used to search UCPath.`,
          );
        }
        const hire = s.hireDate?.trim();
        if (hire && (label === "Section 2" || !rec.hireDate)) {
          rec.hireDate = normalizeI9Dob(hire) ?? hire;
        }
      }
      rec.disputedFields = disputed;
      rec.corroboration = disputed.length > 0 ? "disputed" : "confirmed";
      continue;
    }

    if (rec.formKind === "i9 section 2") {
      const hasS1 = links?.section1Page != null;
      if (!hasS1) {
        rec.orphanSection2 = true;
        rec.warnings.push(
          `Section 2 for "${i9SheetName(rec)}" has no Section 1 page in the merged packet — name-only UCPath check.`,
        );
      }
    }
  }

  for (const rec of previews) {
    rec.checks = buildI9Checks(rec);
  }
  return previews;
}

async function applyRosterEnrichment(records: I9PreviewRecord[]): Promise<void> {
  const { loadEmployeeActionHistory, crossRefI9Record, applyActionHistoryToI9Record } =
    await import("../src/services/matching/employee-action-history.js");
  const actionHistory = await loadEmployeeActionHistory();
  log.step(
    `[run-i9-from-extracted] Action History loaded: ${actionHistory.byEmplId.size} Empl ID(s) from ${actionHistory.sourcePath}`,
  );

  let hits = 0;
  let misses = 0;
  for (const rec of records) {
    const xref = crossRefI9Record(rec, actionHistory);
    applyActionHistoryToI9Record(rec, xref);
    if (isI9Section1(rec)) {
      if (xref.ppsEid || xref.rosterEmplId) hits += 1;
      else misses += 1;
      const name = rec.name || buildI9DisplayName(rec);
      rec.matchState = name ? "resolved" : "unresolved";
      if (!name) {
        rec.warnings.push("Cannot check against UCPath: no legible name on this I-9");
      }
    }
    rec.checks = buildI9Checks(rec);
  }
  log.step(`[run-i9-from-extracted] roster NAME match: ${hits} hit(s), ${misses} miss(es)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const workersIdx = args.indexOf("--workers");
  const workers =
    workersIdx >= 0 && args[workersIdx + 1]
      ? Number.parseInt(args[workersIdx + 1]!, 10)
      : 2;
  const pathArg = args.find((a, i) => i !== workersIdx && i !== workersIdx + 1);
  if (!pathArg || !Number.isFinite(workers) || workers < 1) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/run-i9-check-from-extracted.ts <records.json> [--workers N]",
    );
    process.exit(1);
  }

  const recordsPath = resolve(pathArg);
  const raw = JSON.parse(readFileSync(recordsPath, "utf8")) as ExtractedRecord[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`No records in ${recordsPath}`);
  }

  const records = toPreviewRecords(raw);
  await applyRosterEnrichment(records);

  const sessionId = randomUUID();
  const ocrRunId = randomUUID();
  const operationRunId = randomUUID();
  const operationTraceId = buildTraceId({ code: "ic", runId: operationRunId, at: new Date() });
  const pdfOriginalName = basename(recordsPath);
  const operationItemId = `ocr-prep-${sessionId}`;

  const coordinatorData: Record<string, string> = {
    archetype: "operation",
    mode: "prepare",
    formType: "i9",
    queueRowKind: "file",
    pdfOriginalName,
    ocrRunId,
    ocrSessionId: sessionId,
    operationWorkflow: "i9-check",
    operationKind: "i9",
    operationRunId,
    __id: operationItemId,
    __traceId: operationTraceId,
    workers: String(workers),
  };

  emitTrackerRow({
    workflow: "i9-check",
    timestamp: new Date().toISOString(),
    id: operationItemId,
    runId: operationRunId,
    status: "running",
    step: "ocr-prep",
    data: { ...coordinatorData, ocrStatus: "running", ocrStep: "preparing" },
  });

  emitTrackerRow({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: sessionId,
    runId: ocrRunId,
    parentRunId: operationRunId,
    status: "done",
    step: "ocr",
    data: {
      archetype: "preview",
      mode: "prepare",
      formType: "i9",
      queueRowKind: "file",
      pdfOriginalName,
      operationWorkflow: "i9-check",
      ocrSessionId: sessionId,
      ocrRunId,
      __id: sessionId,
      __traceId: buildTraceId({ code: "ic", runId: ocrRunId, at: new Date() }),
      records: JSON.stringify(records),
      workers: String(workers),
    },
  });

  emitTrackerRow({
    workflow: "i9-check",
    timestamp: new Date().toISOString(),
    id: operationItemId,
    runId: operationRunId,
    status: "running",
    step: "i9-check",
    data: { ...coordinatorData, ocrStatus: "members-queued", ocrStep: "i9-check" },
  });

  log.step(
    `[run-i9-from-extracted] fanning out ${records.length} enriched record(s) under operation ${operationRunId.slice(0, 8)}… (workers=${workers})`,
  );

  const summary = await enqueueI9CheckMemberTasks({
    sessionId,
    ocrRunId,
    operation: {
      workflow: "i9-check",
      runId: operationRunId,
      traceId: operationTraceId,
    },
    runOptions: { workers },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        recordsPath,
        sessionId,
        ocrRunId,
        operationRunId,
        operationTraceId,
        recordCount: records.length,
        ...summary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
