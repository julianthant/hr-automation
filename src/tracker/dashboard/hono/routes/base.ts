
import type { Hono } from "hono";

import {
  cleanOldTrackerFiles,
  listDatesForWorkflow,
  listWorkflows,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  readRunsForId,
  getRunIdOr,
  type TrackerEntry,
} from "../../../jsonl.js";
import { queryRunsForItem } from "../../../state/queries.js";
import { listRosters, resolveRosterDirs } from "../../../../services/matching/roster-loader.js";
import { log } from "../../../../utils/log.js";
import {
  buildRunTimelines,
  computeStepDurations,
  pickEarlier,
  pickLater,
  type StepDurationEntry,
} from "../../run-timelines.js";
import { getDefaultWorkflow, type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { buildWorkflowsHandler } from "../../workflows.js";
import { effectiveMetadata } from "../../../workflow-presentation/effective.js";
import { filterRetiredDashboardWorkflows } from "../../../../domain/dashboard-run-surfaces.js";

// Module-scoped throttle: prune work runs at most once per 60s per
// process. The prune is idempotent, so caching its outcome between
// calls is safe and elides the frontend's preflight-polling cost.
let lastPruneAtMs = 0;
let cachedPruneResult = { deleted: 0, sessionsCleaned: false };
const PRUNE_INTERVAL_MS = 60_000;

/** Test-only: reset the /api/preflight prune throttle so each test sees a fresh prune. */
export function __resetPreflightThrottleForTests(): void {
  lastPruneAtMs = 0;
  cachedPruneResult = { deleted: 0, sessionsCleaned: false };
}

export function registerBaseRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/workflows", () => jsonResponse(filterRetiredDashboardWorkflows(listWorkflows(deps.dir))));

  const root = deps.repoRoot ?? process.cwd();
  app.get("/api/workflow-definitions", () =>
    jsonResponse(buildWorkflowsHandler()().map((m) => effectiveMetadata(m, root))));

  app.get("/api/dates", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    return jsonResponse(listDatesForWorkflow(workflow, deps.dir));
  });

  app.get("/api/entries", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    return jsonResponse(readEntries(workflow, deps.dir));
  });

  app.get("/api/entry-data", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const id = c.req.query("id") ?? "";
    const runId = c.req.query("runId") ?? "";
    const date = c.req.query("date");
    if (!workflow || !id) {
      return jsonResponse({ ok: false, error: "workflow and id are required" }, 400);
    }
    const entries = (date ? readEntriesForDate(workflow, date, deps.dir) : readEntries(workflow, deps.dir))
      .filter((entry) => entry.id === id);
    const richness = (entry: TrackerEntry): number =>
      Object.values(entry.data ?? {}).filter((value) => value != null && String(value).trim() !== "").length;
    const sorted = [...entries].sort((a, b) => {
      const richDiff = richness(b) - richness(a);
      if (richDiff !== 0) return richDiff;
      return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
    });
    const sameRun = runId ? sorted.find((entry) => entry.runId === runId) : undefined;
    const fallback = sorted[0];
    const chosen = sameRun && richness(sameRun) > 0 ? sameRun : fallback;
    return jsonResponse({
      ok: true,
      runId: chosen?.runId ?? null,
      timestamp: chosen?.timestamp ?? null,
      data: chosen?.data ?? {},
      source: chosen ? (chosen.runId === runId ? "active-run" : "fallback") : "none",
    });
  });

  app.get("/api/logs", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const id = c.req.query("id") ?? "";
    const runId = c.req.query("runId") ?? "";
    let logs = readLogEntries(workflow, id || undefined, deps.dir);
    if (runId) logs = logs.filter((entry) => entry.runId ? entry.runId === runId : runId.endsWith("#1"));
    return jsonResponse(logs);
  });

  app.get("/api/runs", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const id = c.req.query("id") ?? "";
    const date = c.req.query("date") ?? undefined;

    if (deps.projectionReady && deps.stateDb && date) {
      try {
        return jsonResponse(queryRunsForItem(deps.stateDb, { workflow, itemId: id, date }));
      } catch (err) {
        log.warn(`SQLite /api/runs fallback to JSONL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const runs = readRunsForId(workflow, id, date, deps.dir);
    const allForItem = date
      ? readEntriesForDate(workflow, date, deps.dir).filter((entry) => entry.id === id)
      : readEntries(workflow, deps.dir).filter((entry) => entry.id === id);
    const historyByRun = new Map<string, StepDurationEntry[]>();
    for (const entry of allForItem) {
      const runId = getRunIdOr(entry);
      const bucket = historyByRun.get(runId);
      const slim: StepDurationEntry = { timestamp: entry.timestamp, status: entry.status, step: entry.step };
      if (bucket) bucket.push(slim);
      else historyByRun.set(runId, [slim]);
    }

    const timelines = buildRunTimelines(allForItem);
    const allLogs = date
      ? readLogEntriesForDate(workflow, id, date, deps.dir)
      : readLogEntries(workflow, id, deps.dir);
    const logFirst = new Map<string, string>();
    const logLast = new Map<string, string>();
    for (const entry of allLogs) {
      const runId = getRunIdOr(entry);
      if (!logFirst.has(runId)) logFirst.set(runId, entry.ts);
      logLast.set(runId, entry.ts);
    }

    return jsonResponse(runs.map((run) => {
      const timeline = timelines.get(run.runId);
      return {
        ...run,
        stepDurations: computeStepDurations(historyByRun.get(run.runId) ?? []),
        firstLogTs: pickEarlier(logFirst.get(run.runId), timeline?.earliestTrackerTs),
        lastLogTs: pickLater(logLast.get(run.runId), timeline?.latestTrackerTs),
        ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
      };
    }));
  });

  app.get("/api/rosters", () => {
    const merged = resolveRosterDirs(deps.dir).flatMap((dir) => listRosters(dir));
    merged.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return jsonResponse(merged.map((roster) => ({
      filename: roster.filename,
      path: roster.path,
      bytes: roster.sizeBytes,
      modifiedAt: new Date(roster.mtimeMs).toISOString(),
    })), 200, { "Cache-Control": "no-store" });
  });

  app.get("/api/preflight", () => {
    const now = Date.now();
    if (now - lastPruneAtMs >= PRUNE_INTERVAL_MS) {
      const deleted = cleanOldTrackerFiles(30, deps.dir);
      cachedPruneResult = { deleted, sessionsCleaned: false };
      lastPruneAtMs = now;
    }
    const { deleted } = cachedPruneResult;
    return jsonResponse({
      checks: [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
      ],
    });
  });
}
