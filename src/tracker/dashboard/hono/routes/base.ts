import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";

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
} from "../../../jsonl.js";
import { getSessionsFilePath } from "../../../session-events.js";
import { queryRunsForItem } from "../../../state/queries.js";
import { listRosters } from "../../../../services/matching/roster-loader.js";
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

export function registerBaseRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/workflows", () => jsonResponse(listWorkflows(deps.dir)));

  app.get("/api/workflow-definitions", () => jsonResponse(buildWorkflowsHandler()()));

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

    if ((deps.projectionReady ?? true) && deps.stateDb && date) {
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
      const runId = entry.runId || `${entry.id}#1`;
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
      const runId = entry.runId || `${entry.itemId}#1`;
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
    const rosterDirs = [
      resolve(process.cwd(), ".tracker/rosters"),
      resolve(process.cwd(), "src/data"),
    ];
    const merged = rosterDirs.flatMap((dir) => listRosters(dir));
    merged.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return jsonResponse(merged.map((roster) => ({
      filename: roster.filename,
      path: roster.path,
      bytes: roster.sizeBytes,
      modifiedAt: new Date(roster.mtimeMs).toISOString(),
    })), 200, { "Cache-Control": "no-store" });
  });

  app.get("/api/preflight", () => {
    const deleted = cleanOldTrackerFiles(30, deps.dir);
    const deletedShots = cleanOldScreenshots(30);
    let sessionsCleaned = false;
    const sessionsPath = getSessionsFilePath(deps.dir);
    if (existsSync(sessionsPath)) {
      const ageMs = Date.now() - statSync(sessionsPath).mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        unlinkSync(sessionsPath);
        sessionsCleaned = true;
      }
    }
    return jsonResponse({
      checks: [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Old screenshots cleaned", passed: true, detail: `${deletedShots} screenshot${deletedShots !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
      ],
    });
  });
}
