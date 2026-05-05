import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { stopDaemons } from "../../../core/daemon-client.js";
import { findAliveDaemons } from "../../../core/daemon-registry.js";
import { readQueueState } from "../../../core/daemon-queue.js";
import { buildCancelQueuedHandler } from "../../dashboard-ops.js";
import {
  readSessionEvents,
  workflowNameFromInstance,
  emitWorkflowEnd,
  type SessionEvent,
} from "../../session-events.js";
import { errorMessage } from "../../../utils/errors.js";
import { log } from "../../../utils/log.js";

export function createDaemonStopRoute(): DashboardRoute {
  return async (req, res, url, ctx) => {
    if (
      req.method !== "POST" ||
      url.pathname !== "/api/daemon/stop"
    ) {
      return false;
    }

    try {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        if (parsed.error === "Invalid JSON body") {
          writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
        } else {
          writeJson(res, 500, { ok: false, error: parsed.error });
        }
        return true;
      }
      const input = parsed.body as { workflow?: string; force?: boolean };
      const workflow = input.workflow?.trim();
      if (!workflow) {
        writeJson(res, 400, { ok: false, error: "workflow is required" });
        return true;
      }
      const force = input.force === true;

      const aliveDaemons = await findAliveDaemons(workflow, ctx.dir);
      const daemonPids = new Set(aliveDaemons.map((d) => d.pid));
      const daemonsStopped = await stopDaemons(workflow, force, ctx.dir);

      const events = ctx.dir ? readSessionEvents(ctx.dir) : readSessionEvents();
      const startsByInstance = new Map<string, SessionEvent>();
      const endedInstances = new Set<string>();
      const browserPidsByInstance = new Map<string, Set<number>>();
      for (const e of events) {
        if (!e.workflowInstance) continue;
        if (workflowNameFromInstance(e.workflowInstance) !== workflow) continue;
        if (e.type === "workflow_start") startsByInstance.set(e.workflowInstance, e);
        if (e.type === "workflow_end") endedInstances.add(e.workflowInstance);
        if (e.type === "browser_launch" && typeof e.chromiumPid === "number") {
          const set = browserPidsByInstance.get(e.workflowInstance) ?? new Set<number>();
          set.add(e.chromiumPid);
          browserPidsByInstance.set(e.workflowInstance, set);
        }
      }
      const ownPid = process.pid;
      const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
      let processesKilled = 0;
      let browsersKilled = 0;
      const killedInstances: string[] = [];

      const targetedInstances = new Set<string>();
      for (const [instance, startEv] of startsByInstance) {
        if (endedInstances.has(instance)) continue;
        const pid = startEv.pid;
        if (!pid || pid === ownPid) continue;
        if (daemonPids.has(pid)) {
          if (force) targetedInstances.add(instance);
          continue;
        }
        try {
          process.kill(pid, 0);
        } catch {
          continue;
        }
        try {
          process.kill(pid, signal);
          processesKilled += 1;
          killedInstances.push(instance);
          targetedInstances.add(instance);
        } catch (e) {
          log.warn(
            `[/api/daemon/stop] failed to ${signal} pid=${pid} instance='${instance}': ${errorMessage(e)}`,
          );
        }
      }

      if (force) {
        for (const instance of targetedInstances) {
          const pids = browserPidsByInstance.get(instance);
          if (!pids) continue;
          for (const cPid of pids) {
            try {
              process.kill(cPid, 0);
            } catch {
              continue;
            }
            try {
              process.kill(cPid, "SIGKILL");
              browsersKilled += 1;
            } catch (e) {
              log.warn(
                `[/api/daemon/stop] failed to SIGKILL chromium pid=${cPid} instance='${instance}': ${errorMessage(e)}`,
              );
            }
          }
        }
      }

      if (processesKilled > 0) {
        log.step(
          `[/api/daemon/stop] ${signal} sent to ${processesKilled} non-daemon ${workflow} process(es): ${killedInstances.join(", ")}`,
        );
      }
      if (browsersKilled > 0) {
        log.step(
          `[/api/daemon/stop] SIGKILL'd ${browsersKilled} orphaned Chromium process(es) for ${workflow}`,
        );
      }

      let phantomsCleared = 0;
      for (const [instance, startEv] of startsByInstance) {
        if (endedInstances.has(instance)) continue;
        const pid = startEv.pid;
        if (!pid || pid === ownPid) continue;
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* dead */
        }
        if (alive) continue;
        try {
          emitWorkflowEnd(instance, "failed", ctx.dir);
          phantomsCleared += 1;
        } catch (e) {
          log.warn(
            `[/api/daemon/stop] failed to synthesize workflow_end for phantom '${instance}': ${errorMessage(e)}`,
          );
        }
      }
      if (phantomsCleared > 0) {
        log.step(
          `[/api/daemon/stop] cleared ${phantomsCleared} phantom ${workflow} instance(s) from SessionPanel`,
        );
      }

      let queuedCancelled = 0;
      if (force) {
        try {
          const state = await readQueueState(workflow, ctx.dir);
          const cancelHandler = buildCancelQueuedHandler(ctx.dir);
          for (const item of state.queued) {
            const result = await cancelHandler({ workflow, id: item.id });
            if (result.ok) queuedCancelled += 1;
          }
          if (queuedCancelled > 0) {
            log.step(
              `[/api/daemon/stop] cancelled ${queuedCancelled} queued ${workflow} item(s) on force-stop`,
            );
          }
        } catch (e) {
          log.warn(
            `[/api/daemon/stop] failed to cancel queued items: ${errorMessage(e)}`,
          );
        }
      }

      writeJson(res, 200, {
        ok: true,
        workflow,
        force,
        stopped: daemonsStopped + processesKilled,
        daemonsStopped,
        processesKilled,
        browsersKilled,
        queuedCancelled,
        phantomsCleared,
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: errorMessage(e) });
    }
    return true;
  };
}
