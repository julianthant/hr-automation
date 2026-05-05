import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { DashboardRoute } from "../route-types.js";
import { writeJson } from "../http.js";
import {
  cleanOldScreenshots,
  cleanOldTrackerFiles,
  listDatesForWorkflow,
  listWorkflows,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  readRunsForId,
  type TrackerEntry,
} from "../../jsonl.js";
import { getSessionsFilePath } from "../../session-events.js";
import { getAll as getAllRegisteredWorkflows } from "../../../core/registry.js";
import type { WorkflowMetadata } from "../../../core/types.js";
import { listRosters } from "../../../match/roster-loader.js";
import {
  buildRunTimelines,
  computeStepDurations,
  pickEarlier,
  pickLater,
  type StepDurationEntry,
} from "../run-timelines.js";

export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}

export function createBaseRoutes(): DashboardRoute {
  return async (_req, res, url, ctx) => {
    const { workflow, dir } = ctx;
    const req = _req;

    if (url.pathname === "/api/workflows") {
      writeJson(res, 200, listWorkflows(dir));
      return true;
    }

    if (url.pathname === "/api/workflow-definitions") {
      writeJson(res, 200, getAllRegisteredWorkflows());
      return true;
    }

    if (url.pathname === "/api/dates") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      writeJson(res, 200, listDatesForWorkflow(wf, dir));
      return true;
    }

    if (url.pathname === "/api/entries") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      writeJson(res, 200, readEntries(wf, dir));
      return true;
    }

    if (url.pathname === "/api/entry-data") {
      // Returns the richest tracker `data` map for a given (workflow, id,
      // runId) - used by EditDataTab's "Refresh from logs" button to refill
      // the form from whatever the latest run extracted. Falls back to the
      // richest data across runs of this id if the requested runId has nothing.
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date");
      if (!wf || !id) {
        writeJson(res, 400, { ok: false, error: "workflow and id are required" });
        return true;
      }
      const entries = (date ? readEntriesForDate(wf, date, dir) : readEntries(wf, dir))
        .filter((e) => e.id === id);
      // Pick the richest (most non-empty fields) entry for the runId. The
      // last-running tracker row usually has the fullest `data` (kernel
      // updates merge into ctx.data, written on every step transition).
      // If the runId match is empty (e.g. user views run #2 which never
      // emitted any data because it was cancelled), fall back to richest
      // across all runs of this id.
      const richness = (e: TrackerEntry): number =>
        Object.values(e.data ?? {}).filter((v) => v != null && String(v).trim() !== "").length;
      const sorted = [...entries].sort((a, b) => {
        const r = richness(b) - richness(a);
        if (r !== 0) return r;
        return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
      });
      const sameRun = runId ? sorted.find((e) => e.runId === runId) : undefined;
      const fallback = sorted[0];
      const chosen = (sameRun && richness(sameRun) > 0) ? sameRun : fallback;
      writeJson(res, 200, {
        ok: true,
        runId: chosen?.runId ?? null,
        timestamp: chosen?.timestamp ?? null,
        data: chosen?.data ?? {},
        source: chosen ? (chosen.runId === runId ? "active-run" : "fallback") : "none",
      });
      return true;
    }

    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      let logs = readLogEntries(wf, id || undefined, dir);
      // Logs without runId belong to run #1 only
      if (runId) logs = logs.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));
      writeJson(res, 200, logs);
      return true;
    }

    if (url.pathname === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const date = url.searchParams.get("date") ?? undefined;

      // Attach per-run step durations, a single timeline span (covers both
      // the synthetic auth tracker entries and the handler's log lines), and
      // a chronological ordinal so the UI labels runs consistently even for
      // UUID-format runIds. Both shapes ({id}#N, UUID) share the SAME
      // ordinal-assignment rule - see `buildRunTimelines`.
      const runs = readRunsForId(wf, id, date, dir);

      const allForItem = date
        ? readEntriesForDate(wf, date, dir).filter((e) => e.id === id)
        : readEntries(wf, dir).filter((e) => e.id === id);
      const historyByRun = new Map<string, StepDurationEntry[]>();
      for (const e of allForItem) {
        const rid = e.runId || `${e.id}#1`;
        const bucket = historyByRun.get(rid);
        const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
        if (bucket) bucket.push(slim);
        else historyByRun.set(rid, [slim]);
      }

      const timelines = buildRunTimelines(allForItem);

      const allLogs = date
        ? readLogEntriesForDate(wf, id, date, dir)
        : readLogEntries(wf, id, dir);
      const logFirst = new Map<string, string>();
      const logLast = new Map<string, string>();
      for (const l of allLogs) {
        const rid = l.runId || `${l.itemId}#1`;
        if (!logFirst.has(rid)) logFirst.set(rid, l.ts);
        logLast.set(rid, l.ts);
      }

      const enrichedRuns = runs.map((r) => {
        const timeline = timelines.get(r.runId);
        return {
          ...r,
          stepDurations: computeStepDurations(historyByRun.get(r.runId) ?? []),
          firstLogTs: pickEarlier(logFirst.get(r.runId), timeline?.earliestTrackerTs),
          lastLogTs: pickLater(logLast.get(r.runId), timeline?.latestTrackerTs),
          ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
        };
      });
      writeJson(res, 200, enrichedRuns);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/rosters") {
      const rosterDirs = [
        resolve(process.cwd(), ".tracker/rosters"),
        resolve(process.cwd(), "src/data"),
      ];
      const merged = rosterDirs.flatMap((d) => listRosters(d));
      merged.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const rows = merged.map((r) => ({
        filename: r.filename,
        path: r.path,
        bytes: r.sizeBytes,
        modifiedAt: new Date(r.mtimeMs).toISOString(),
      }));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(rows));
      return true;
    }

    if (url.pathname === "/api/preflight") {
      // 30-day floor so the operator always has at least the last month
      // of workflow history + screenshots available for retro investigation.
      const deleted = cleanOldTrackerFiles(30, dir);
      const deletedShots = cleanOldScreenshots(30);

      // Only delete sessions.jsonl if it hasn't been touched for >24h (truly stale).
      // Stale workflows from crashed processes are handled by rebuildSessionState
      // which marks dead-PID workflows as inactive at read time - no file mutation needed.
      let sessionsCleaned = false;
      const sessPath = getSessionsFilePath(dir);
      if (existsSync(sessPath)) {
        const ageMs = Date.now() - statSync(sessPath).mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          unlinkSync(sessPath);
          sessionsCleaned = true;
        }
      }

      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Old screenshots cleaned", passed: true, detail: `${deletedShots} screenshot${deletedShots !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
      ];
      writeJson(res, 200, { checks });
      return true;
    }

    return false;
  };
}
