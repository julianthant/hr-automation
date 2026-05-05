import { readFile as readFileAsync } from "node:fs/promises";
import type { DashboardRoute } from "../route-types.js";
import { writeSseHeaders } from "../http.js";
import {
  dateLocal,
  listWorkflows,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  type TrackerEntry,
} from "../../jsonl.js";
import {
  getSessionsFilePath,
  type SessionEvent,
} from "../../session-events.js";
import {
  filterEventsForRun,
  rebuildSessionState,
} from "../session-state.js";
import {
  buildRunTimelines,
  computeStepDurations,
  pickEarlier,
  pickLater,
  type RunTimeline,
  type StepDurationEntry,
} from "../run-timelines.js";
import { isResolvedPrepEntry } from "../prep-rows.js";
import { computeFailureCounts } from "../failures.js";
import { buildScreenshotsHandler } from "../screenshots.js";
import {
  scanFailurePatterns,
  scanOrphanedQueueItems,
} from "../sweeps.js";

export function createEventsRoute(): DashboardRoute {
  return async (_req, res, url, ctx) => {
    const { workflow, dir } = ctx;
    const req = _req;

    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      writeSseHeaders(res);
      let sentCount = 0;
      let firstTick = true;
      const send = () => {
        let entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date, dir)
          : readLogEntries(wf, id || undefined, dir);
        // Logs without runId belong to run #1 only
        if (runId) entries = entries.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));

        if (firstTick) {
          // First tick: ALWAYS send - even an empty array. The frontend's
          // useLogs hook transitions from "loading skeleton" to "loaded"
          // on its first message; skipping the write for an empty dataset
          // leaves the UI stuck on skeleton forever (e.g. for a runId that
          // has a pending/failed tracker row but never produced any logs).
          res.write(`data: ${JSON.stringify(entries)}\n\n`);
          sentCount = entries.length;
          firstTick = false;
        } else if (entries.length > sentCount) {
          // Subsequent ticks: send only new logs
          res.write(`data: ${JSON.stringify(entries.slice(sentCount))}\n\n`);
          sentCount = entries.length;
        }
      };
      send();
      const interval = setInterval(send, 500);
      req.on("close", () => clearInterval(interval));
      return true;
    }

    if (url.pathname === "/events/run-events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const requestedRunId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      writeSseHeaders(res);

      // Batch / pool / daemon workflows call `Session.launch` at batch scope
      // (outside per-item `withLogContext`), so their `auth_*` and
      // `browser_launch` session events carry a `workflowInstance` but no
      // `runId`. `filterEventsForRun` resolves `runId -> tracker entry ->
      // data.instance` and pulls in those batch-scope events by matching
      // instance. See `filterEventsForRun` jsdoc for the full contract.

      let sentCount = 0;
      let firstTick = true;

      const send = async () => {
        // Read session events tolerantly - skip malformed lines instead of
        // letting a bad JSON line break the whole poll cycle. `readSessionEvents`
        // does a strict JSON.parse, so we inline a best-effort reader here.
        const sessionsPath = getSessionsFilePath(dir);
        const allEvents: SessionEvent[] = [];
        try {
          const raw = await readFileAsync(sessionsPath, "utf-8");
          for (const line of raw.split("\n")) {
            if (!line) continue;
            try {
              allEvents.push(JSON.parse(line) as SessionEvent);
            } catch {
              // Skip unparseable JSONL lines without derailing the stream.
            }
          }
        } catch {
          // ENOENT or other read failure -> empty list; next tick may recover.
        }

        let trackerEntries: TrackerEntry[] = [];
        try {
          trackerEntries = (date && date !== today)
            ? readEntriesForDate(wf, date, dir)
            : readEntries(wf, dir);
        } catch {
          // Tracker read failure -> instance fallback becomes a no-op for this tick.
        }

        const filtered = filterEventsForRun(allEvents, trackerEntries, requestedRunId);

        if (firstTick) {
          // First tick: ALWAYS send - matching /events/logs. Empty-array
          // sends are how useRunEvents learns "full history has been
          // delivered (and there's none)", dismissing its skeleton.
          res.write(`data: ${JSON.stringify(filtered)}\n\n`);
          sentCount = filtered.length;
          firstTick = false;
        } else if (filtered.length > sentCount) {
          res.write(`data: ${JSON.stringify(filtered.slice(sentCount))}\n\n`);
          sentCount = filtered.length;
        }
      };

      void send();
      const interval = setInterval(() => void send(), 500);
      req.on("close", () => clearInterval(interval));
      return true;
    }

    // --- Telegram-sent SSE ----------------------------------
    //
    // Streams every `telegram_sent` session event (delta semantics - first
    // tick replays history, subsequent ticks send only new entries) so the
    // frontend can toast each notification. Cross-workflow / no filter:
    // any operator running any workflow on this dashboard's machine sees
    // the same toasts, which matches the expected single-operator setup.
    if (url.pathname === "/events/telegram") {
      writeSseHeaders(res);
      let sentCount = 0;
      let firstTick = true;
      const send = async () => {
        const sessionsPath = getSessionsFilePath(dir);
        const events: SessionEvent[] = [];
        try {
          const raw = await readFileAsync(sessionsPath, "utf-8");
          for (const line of raw.split("\n")) {
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as SessionEvent;
              if (ev.type === "telegram_sent") events.push(ev);
            } catch {
              // skip
            }
          }
        } catch {
          // ENOENT or other read failure -> empty list; next tick recovers.
        }
        if (firstTick) {
          res.write(`data: ${JSON.stringify(events)}\n\n`);
          sentCount = events.length;
          firstTick = false;
        } else if (events.length > sentCount) {
          res.write(`data: ${JSON.stringify(events.slice(sentCount))}\n\n`);
          sentCount = events.length;
        }
      };
      void send();
      const interval = setInterval(() => void send(), 1_000);
      req.on("close", () => clearInterval(interval));
      return true;
    }

    if (url.pathname === "/events/sessions") {
      writeSseHeaders(res);
      const send = () => {
        const state = rebuildSessionState(dir);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return true;
    }

    if (url.pathname === "/events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      writeSseHeaders(res);
      const send = () => {
        // `raw` holds every JSONL record for this workflow/date, including the
        // pending/running/done/failed chain per (itemId, runId). We need the
        // full chain for stepDurations; useEntries dedupes to the latest per id
        // on the frontend.
        const raw = (date && date !== today)
          ? readEntriesForDate(wf, date, dir)
          : readEntries(wf, dir);
        const entries = raw;

        // Enrich entries with per-run log-derived timestamps for accurate elapsed
        const logs = (date && date !== today)
          ? readLogEntriesForDate(wf, undefined, date, dir)
          : readLogEntries(wf, undefined, dir);
        // Key: "itemId::runId" - logs without runId are assigned to run #1
        const logFirst = new Map<string, string>();
        const logLast = new Map<string, string>();
        const logLastMsg = new Map<string, string>();
        for (const l of logs) {
          const rid = l.runId || `${l.itemId}#1`;
          const key = `${l.itemId}::${rid}`;
          if (!logFirst.has(key)) logFirst.set(key, l.ts);
          logLast.set(key, l.ts);
          logLastMsg.set(key, l.message);
        }

        // Compute step durations per (itemId, runId) from the full JSONL
        // history, not the deduped view. Each entry in `entries` inherits
        // the durations for its own run.
        const runHistory = new Map<string, StepDurationEntry[]>();
        for (const e of entries) {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          const bucket = runHistory.get(key);
          const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
          if (bucket) bucket.push(slim);
          else runHistory.set(key, [slim]);
        }
        const stepDurationsByRun = new Map<string, Record<string, number>>();
        for (const [key, rows] of runHistory) {
          stepDurationsByRun.set(key, computeStepDurations(rows));
        }

        // Per-item run timelines: ordinal + tracker-span. Enrichment below
        // folds `earliestTrackerTs` into firstLogTs and `latestTrackerTs`
        // into lastLogTs so the header Elapsed timer and queue-row elapsed
        // both anchor at the run's REAL start (which for batch items is
        // the synthetic auth running entry, pre-handler). This makes the
        // step pipeline tile elapsed exactly - sum(stepDurations) ==
        // (lastLogTs - firstLogTs). See RunTimeline JSDoc for why.
        const entriesByItem = new Map<string, TrackerEntry[]>();
        for (const e of entries) {
          const arr = entriesByItem.get(e.id) ?? [];
          arr.push(e);
          entriesByItem.set(e.id, arr);
        }
        const timelinesByItem = new Map<string, Map<string, RunTimeline>>();
        for (const [itemId, rows] of entriesByItem) {
          timelinesByItem.set(itemId, buildRunTimelines(rows));
        }

        // Screenshot count for failed entries - counted once per (wf, itemId)
        // pair so repeat lookups in the loop don't hit the FS N times.
        const screenshotCountByItem = new Map<string, number>();
        const screenshotsHandler = buildScreenshotsHandler();

        const enriched = entries.map((e) => {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          let screenshotCount: number | undefined;
          if (e.status === "failed") {
            const sKey = `${e.workflow}::${e.id}`;
            let c = screenshotCountByItem.get(sKey);
            if (c === undefined) {
              try {
                c = screenshotsHandler(e.workflow, e.id).length;
              } catch {
                c = 0;
              }
              screenshotCountByItem.set(sKey, c);
            }
            screenshotCount = c;
          }
          // Fold the tracker-span into firstLogTs/lastLogTs so the frontend
          // reads a single "run start -> now" window that includes the
          // synthetic auth entries (batch mode) or the pending entry (single
          // mode). Min/max across both sources keeps legacy log-only runs
          // behaving the same.
          const timeline = timelinesByItem.get(e.id)?.get(rid);
          const logFirstTs = logFirst.get(key);
          const logLastTs = logLast.get(key);
          const trackerFirstTs = timeline?.earliestTrackerTs;
          const trackerLastTs = timeline?.latestTrackerTs;
          const spanFirstTs = pickEarlier(logFirstTs, trackerFirstTs);
          const spanLastTs = pickLater(logLastTs, trackerLastTs);

          return {
            ...e,
            firstLogTs: spanFirstTs,
            lastLogTs: spanLastTs,
            lastLogMessage: logLastMsg.get(key),
            stepDurations: stepDurationsByRun.get(key) ?? {},
            ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
            ...(screenshotCount !== undefined ? { screenshotCount } : {}),
          };
        });

        const workflows = listWorkflows(dir);
        // Count unique items per workflow for dropdown badges, scoped to the
        // selected date. Dedupe by `id` so multiple runs of the same item
        // (retries) collapse into one - the operator wants "how many distinct
        // subjects on this date," not "how many attempts." Using readEntries(w)
        // - which only reads today's file - would show 0 when viewing a past
        // date, even if that date had real activity.
        const wfCounts: Record<string, number> = {};
        const failureCounts: Record<string, number> = {};
        const targetDate = date || today;
        for (const w of workflows) {
          const all = readEntriesForDate(w, targetDate, dir);
          // Dedupe by id and exclude resolved prep rows (operator-approved
          // or operator-discarded) so the sidebar badge stays in sync with
          // QueuePanel's visible-entries filter.
          const latestById = new Map<string, TrackerEntry>();
          for (const e of all) {
            const prev = latestById.get(e.id);
            if (!prev || prev.timestamp <= e.timestamp) latestById.set(e.id, e);
          }
          let count = 0;
          for (const e of latestById.values()) {
            if (isResolvedPrepEntry(e)) continue;
            count++;
          }
          wfCounts[w] = count;
          const n = computeFailureCounts(all);
          if (n > 0) failureCounts[w] = n;
        }
        res.write(`data: ${JSON.stringify({ entries: enriched, workflows, wfCounts, failureCounts })}\n\n`);

        // After each poll, scan for repeated-failure patterns. Fire-and-forget
        // - the SSE response doesn't wait on it, and scanFailurePatterns
        // swallows its own errors so a notification glitch can't derail the
        // cycle.
        void scanFailurePatterns();
        // Safety net for queued items whose daemon died without running its
        // own orphan-queue cleanup (force-kill, OS crash). Marks them failed
        // so pending rows don't stick. Idempotent + cheap when queues are
        // empty.
        void scanOrphanedQueueItems(dir);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return true;
    }

    return false;
  };
}
