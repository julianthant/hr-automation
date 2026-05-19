/**
 * HTTP handlers for /api/oath-upload/*. Mirrors the dashboard OCR route
 * handler modules.
 *
 *  - check-duplicate: read-only — scans recent oath-upload JSONLs for the hash
 *  - start:           fire-and-forget runOathUploadCli (caller has already
 *                     persisted the PDF + computed hash)
 *  - cancel:          writes the cancel-request sentinel that the watcher polls
 *  - sweepStuckOathUploadRows: restart-time orphan cleanup
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trackEvent, readLatestTrackerEntriesByRunKey } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { errorMessage } from "../../../utils/errors.js";
import { log } from "../../../utils/log.js";
import {
  findPriorRunsForHash,
  type PriorRunSummary,
} from "../../../workflows/oath-upload/duplicate-check.js";

const WORKFLOW = "oath-upload";

// ─── /api/oath-upload/check-duplicate ────────────────────────

export interface DuplicateCheckInput {
  hash: string;
  lookbackDays?: number;
}
export interface DuplicateCheckResponse {
  status: 200 | 400;
  body:
    | { ok: true; priorRuns: PriorRunSummary[] }
    | { ok: false; error: string };
}
export interface DuplicateCheckHandlerOpts {
  trackerDir?: string;
}

export function buildOathUploadDuplicateCheckHandler(
  opts: DuplicateCheckHandlerOpts = {},
): (input: DuplicateCheckInput) => Promise<DuplicateCheckResponse> {
  return async (input) => {
    if (!/^[0-9a-f]{64}$/.test(input.hash ?? "")) {
      return { status: 400, body: { ok: false, error: "invalid hash" } };
    }
    const priorRuns = findPriorRunsForHash({
      hash: input.hash,
      trackerDir: opts.trackerDir,
      lookbackDays: input.lookbackDays,
    });
    return { status: 200, body: { ok: true, priorRuns } };
  };
}

// ─── /api/oath-upload/start ──────────────────────────────────

export interface StartInput {
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  pdfHash: string;
  sessionId?: string;
  mode?: "full" | "upload-only";
  /** Roster source for the delegated OCR step. Defaults to "download". */
  rosterMode?: "existing" | "download";
  /** Required when `rosterMode === "existing"`. Resolved by the route from disk. */
  rosterPath?: string;
  dryRun?: boolean;
}
export interface StartResponse {
  status: 202 | 400 | 500;
  body:
    | { ok: true; sessionId: string }
    | { ok: false; error: string };
}
export interface StartHandlerOpts {
  trackerDir?: string;
  /** Test/escape-hatch override for the daemon-enqueue side effect. */
  runOathUploadCli?: (
    inputs: import("../../../workflows/oath-upload/schema.js").OathUploadInput[],
  ) => Promise<void>;
}

export function buildOathUploadStartHandler(
  opts: StartHandlerOpts = {},
): (input: StartInput) => Promise<StartResponse> {
  const runCli =
    opts.runOathUploadCli ??
    (async (inputs) => {
      const { runOathUploadCli } = await import(
        "../../../workflows/oath-upload/index.js"
      );
      await runOathUploadCli(inputs);
    });
  return async (input) => {
    if (!input.pdfPath || !input.pdfOriginalName) {
      return { status: 400, body: { ok: false, error: "Missing pdfPath/pdfOriginalName" } };
    }
    if (!/^[0-9a-f]{64}$/.test(input.pdfHash ?? "")) {
      return { status: 400, body: { ok: false, error: "invalid pdfHash" } };
    }
    const mode = input.mode ?? "full";
    if (mode !== "full" && mode !== "upload-only") {
      return { status: 400, body: { ok: false, error: "invalid mode" } };
    }
    const rosterMode = input.rosterMode ?? "download";
    if (mode === "full" && rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: 'rosterMode="existing" requires rosterPath' },
      };
    }
    const sessionId = input.sessionId ?? randomUUID();
    void runCli([
      {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        pdfFileId: input.pdfFileId,
        sessionId,
        pdfHash: input.pdfHash,
        mode,
        rosterMode,
        rosterPath: input.rosterPath,
        dryRun: input.dryRun,
      },
    ]).catch((err) =>
      log.error(`[oath-upload-http] runOathUploadCli threw: ${errorMessage(err)}`),
    );
    return { status: 202, body: { ok: true, sessionId } };
  };
}

// ─── /api/oath-upload/cancel ─────────────────────────────────

export interface CancelInput {
  sessionId: string;
  runId?: string;
  reason?: string;
}
export interface CancelResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface CancelHandlerOpts {
  trackerDir?: string;
}

export function buildOathUploadCancelHandler(opts: CancelHandlerOpts = {}) {
  return async (input: CancelInput): Promise<CancelResponse> => {
    if (!input.sessionId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId" } };
    }
    const runId =
      input.runId ?? findLatestRunIdForSession(input.sessionId, opts.trackerDir) ?? "";
    if (!runId) {
      return {
        status: 400,
        body: { ok: false, error: "no active oath-upload row for sessionId" },
      };
    }
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId,
        status: "running",
        step: "cancel-requested",
        ...(input.reason ? { data: { reason: input.reason } } : {}),
      },
      opts.trackerDir,
    );
    return { status: 200, body: { ok: true } };
  };
}

function findLatestRunIdForSession(
  sessionId: string,
  trackerDir: string | undefined,
): string | null {
  const entry = findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir: trackerDir ?? ".tracker",
    lookbackDays: 7,
    predicate: (e) => e.id === sessionId && Boolean(e.runId),
  });
  return entry?.runId ?? null;
}

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOathUploadRows(trackerDir: string): void {
  const latestById = readLatestTrackerEntriesByRunKey(WORKFLOW, trackerDir);
  for (const e of latestById.values()) {
    if (e.status === "pending" || e.status === "running") {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: e.id,
          runId: e.runId,
          ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
          status: "failed",
          step: "swept",
          error:
            "Dashboard restarted while oath-upload was in progress — please re-upload",
          ...(e.data ? { data: { ...e.data } } : {}),
        },
        trackerDir,
      );
    }
  }
}

// ─── PDF persistence helper for the multipart route ──────────

/** Save the multipart PDF buffer under `<trackerDir>/uploads/<uuid>-<filename>`. */
export async function saveUploadedPdf(
  bytes: Buffer,
  filename: string,
  trackerDir: string,
): Promise<string> {
  const dir = join(trackerDir, "uploads");
  await mkdir(dir, { recursive: true });
  const sanitized = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  const path = join(dir, `${randomUUID()}-${sanitized}`);
  await writeFile(path, bytes);
  return path;
}
