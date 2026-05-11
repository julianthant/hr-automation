import type { Hono } from "hono";

import { stopDaemons } from "../../../../core/daemon/client.js";
import { readQueueState } from "../../../../core/daemon/queue.js";
import { findAliveDaemons } from "../../../../core/daemon/registry.js";
import { errorMessage } from "../../../../utils/errors.js";
import { log } from "../../../../utils/log.js";
import { buildCancelQueuedHandler } from "../../ops/index.js";
import {
  emitWorkflowEnd,
  readSessionEvents,
  workflowNameFromInstance,
  type SessionEvent,
} from "../../../session-events.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerDaemonStopRoute(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/daemon/stop", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 4096);
      if (!parsed.ok) {
        return parsed.error === "Invalid JSON body"
          ? jsonResponse({ ok: false, error: "Invalid JSON body" }, 400)
          : jsonResponse({ ok: false, error: parsed.error }, 500);
      }
      const input = parsed.body as { workflow?: string; force?: boolean };
      const workflow = input.workflow?.trim();
      if (!workflow) return jsonResponse({ ok: false, error: "workflow is required" }, 400);
      const force = input.force === true;

      const aliveDaemonsBefore = await findAliveDaemons(workflow, deps.dir);
      const daemonPids = new Set(aliveDaemonsBefore.map((daemon) => daemon.pid));
      const daemonsStopped = await stopDaemons(workflow, force, deps.dir);

      const events = readSessionEvents(deps.dir);
      const startsByInstance = new Map<string, SessionEvent>();
      const endedInstances = new Set<string>();
      const browserPidsByInstance = new Map<string, Set<number>>();
      for (const event of events) {
        if (!event.workflowInstance) continue;
        if (workflowNameFromInstance(event.workflowInstance) !== workflow) continue;
        if (event.type === "workflow_start") startsByInstance.set(event.workflowInstance, event);
        if (event.type === "workflow_end") endedInstances.add(event.workflowInstance);
        if (event.type === "browser_launch" && typeof event.chromiumPid === "number") {
          const set = browserPidsByInstance.get(event.workflowInstance) ?? new Set<number>();
          set.add(event.chromiumPid);
          browserPidsByInstance.set(event.workflowInstance, set);
        }
      }

      // Session drawer closure is driven by `workflow_end`. The legacy phantom
      // path only synthesized an end when `process.kill(pid, 0)` failed — but
      // defunct/zombie OS PIDs can still answer kill(0), so the card stayed
      // "alive" forever after browsers were torn down. When we had lockfile+
      // /whoami-proven daemon PIDs before stop and the registry shows them
      // gone afterward, synthesize workflow_end unconditionally for matching
      // workflow_start.pid rows (daemon registry is authoritative for "this
      // workflow's workers are toast").
      let phantomsCleared = 0;
      if (daemonPids.size > 0) {
        await new Promise<void>((r) => setTimeout(r, 250));
        const aliveAfterStop = await findAliveDaemons(workflow, deps.dir);
        const survivedDaemonPids = new Set(aliveAfterStop.map((d) => d.pid));
        for (const daemonPid of daemonPids) {
          if (survivedDaemonPids.has(daemonPid)) continue;
          for (const [instance, startEvent] of startsByInstance) {
            if (endedInstances.has(instance)) continue;
            if (startEvent.pid !== daemonPid) continue;
            try {
              emitWorkflowEnd(instance, "failed", deps.dir);
              endedInstances.add(instance);
              phantomsCleared += 1;
            } catch (err) {
              log.warn(
                `[/api/daemon/stop] failed to synthesize workflow_end for stopped daemon '${instance}': ${errorMessage(err)}`,
              );
            }
          }
        }
        if (phantomsCleared > 0) {
          log.step(
            `[/api/daemon/stop] closed ${phantomsCleared} ${workflow} session drawer instance(s) (daemon(s) gone from registry)`,
          );
        }
      }

      const ownPid = process.pid;
      const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
      let processesKilled = 0;
      let browsersKilled = 0;
      const killedInstances: string[] = [];
      const targetedInstances = new Set<string>();

      for (const [instance, startEvent] of startsByInstance) {
        if (endedInstances.has(instance)) continue;
        const pid = startEvent.pid;
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
        } catch (err) {
          log.warn(`[/api/daemon/stop] failed to ${signal} pid=${pid} instance='${instance}': ${errorMessage(err)}`);
        }
      }

      if (force) {
        for (const instance of targetedInstances) {
          const pids = browserPidsByInstance.get(instance);
          if (!pids) continue;
          for (const pid of pids) {
            try {
              process.kill(pid, 0);
            } catch {
              continue;
            }
            try {
              process.kill(pid, "SIGKILL");
              browsersKilled += 1;
            } catch (err) {
              log.warn(`[/api/daemon/stop] failed to SIGKILL chromium pid=${pid} instance='${instance}': ${errorMessage(err)}`);
            }
          }
        }
      }

      if (processesKilled > 0) {
        log.step(`[/api/daemon/stop] ${signal} sent to ${processesKilled} non-daemon ${workflow} process(es): ${killedInstances.join(", ")}`);
      }
      if (browsersKilled > 0) {
        log.step(`[/api/daemon/stop] SIGKILL'd ${browsersKilled} orphaned Chromium process(es) for ${workflow}`);
      }

      const afterRegistryPhantoms = phantomsCleared;
      for (const [instance, startEvent] of startsByInstance) {
        if (endedInstances.has(instance)) continue;
        const pid = startEvent.pid;
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
          emitWorkflowEnd(instance, "failed", deps.dir);
          endedInstances.add(instance);
          phantomsCleared += 1;
        } catch (err) {
          log.warn(`[/api/daemon/stop] failed to synthesize workflow_end for phantom '${instance}': ${errorMessage(err)}`);
        }
      }
      if (phantomsCleared > afterRegistryPhantoms) {
        log.step(
          `[/api/daemon/stop] cleared ${phantomsCleared - afterRegistryPhantoms} phantom ${workflow} instance(s) from session drawer (pid probe)`,
        );
      }

      let queuedCancelled = 0;
      if (force) {
        try {
          const state = await readQueueState(workflow, deps.dir);
          const cancelHandler = buildCancelQueuedHandler(deps.dir);
          for (const item of state.queued) {
            const result = await cancelHandler({ workflow, id: item.id });
            if (result.ok) queuedCancelled += 1;
          }
          if (queuedCancelled > 0) {
            log.step(`[/api/daemon/stop] cancelled ${queuedCancelled} queued ${workflow} item(s) on force-stop`);
          }
        } catch (err) {
          log.warn(`[/api/daemon/stop] failed to cancel queued items: ${errorMessage(err)}`);
        }
      }

      return jsonResponse({
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
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}
