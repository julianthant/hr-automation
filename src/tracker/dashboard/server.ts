import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import {
  cleanOldTrackerFiles,
  DEFAULT_DIR,
  dateLocal,
} from "../jsonl.js";
import { resumeRecoverableOcrApprovals, sweepStuckOcrRows } from "./ocr/index.js";
import { sweepStuckOathUploadRows } from "./oath-upload/http.js";
import { openStateDb } from "../state/db.js";
import { rebuildProjectionForAllDates } from "../state/rebuild.js";
import { startDependencyScheduler } from "../tasks/scheduler.js";
import { sweepOrphanUploadDirs } from "../../scripts/ops/clean-tracker.js";
import { sweepStaleRunScreenshots } from "../state/screenshot-sweep.js";
import { PATHS } from "../../config.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { createDashboardHonoApp, createPublicCaptureHonoApp } from "./hono/app.js";
import {
  createDashboardAccessPolicy,
  REMOTE_ADDRESS_HEADER,
  resolveDashboardBindHost,
} from "./hono/security.js";
import { captureStore } from "./capture-state.js";
import {
  scanFailurePatterns,
  scanOrphanedQueueItems,
} from "./sweeps.js";
import { runRowLifecycleDebugSweep } from "../row-lifecycle-debug.js";
import { readOperatorSettingsFileState } from "../settings/store.js";

let server: Server | null = null;

function withTrustedRemoteAddress(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Always overwrite the client-supplied value. Access middleware may trust
    // this header only because it is injected at the Node socket boundary.
    req.headers[REMOTE_ADDRESS_HEADER] = req.socket.remoteAddress ?? "";
    listener(req, res);
  };
}

export interface StartDashboardOptions {
  noClean?: boolean;
  cleanMaxAgeDays?: number;
  dir?: string;
  screenshotsDir?: string;
  uploadPort?: number | null;
  serveStatic?: boolean;
  host?: string;
  captureHost?: string;
  repoRoot?: string;
}

export interface CreateDashboardServerOptions {
  workflow?: string;
  port?: number;
  dir?: string;
  noClean?: boolean;
  cleanMaxAgeDays?: number;
  screenshotsDir?: string;
  uploadPort?: number | null;
  serveStatic?: boolean;
  host?: string;
  captureHost?: string;
  repoRoot?: string;
}

export function startDashboard(
  workflow: string,
  port: number = 3838,
  opts: StartDashboardOptions = {},
): void {
  if (server) return;
  const uploadPort =
    opts.uploadPort === undefined ? port + 1 : opts.uploadPort;
  server = createDashboardServer({
    workflow,
    port,
    uploadPort,
    dir: opts.dir,
    noClean: opts.noClean,
    cleanMaxAgeDays: opts.cleanMaxAgeDays,
    screenshotsDir: opts.screenshotsDir,
    serveStatic: opts.serveStatic,
    host: opts.host,
    captureHost: opts.captureHost,
    repoRoot: opts.repoRoot,
  });
}

export function createDashboardServer(opts: CreateDashboardServerOptions = {}): Server {
  const workflow = opts.workflow ?? "onboarding";
  const port = opts.port ?? 3838;
  const dir = opts.dir ?? DEFAULT_DIR;
  const host = resolveDashboardBindHost(opts.host);
  const repoRoot = opts.repoRoot ?? process.cwd();
  const workflowMutationsAllowed = (): boolean =>
    readOperatorSettingsFileState(repoRoot).state !== "fault";

  if (!opts.noClean) {
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deleted = cleanOldTrackerFiles(maxAge, dir);
      if (deleted > 0) {
        log.step(`Pruned ${deleted} tracker file${deleted === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Tracker startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    runScreenshotSweep(dir, opts.screenshotsDir);
    if (workflowMutationsAllowed()) {
      try {
        sweepStuckOcrRows(dir);
      } catch (err) {
        log.step(`OCR sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        sweepStuckOathUploadRows(dir);
      } catch (err) {
        log.step(`oath-upload sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log.warn("Configuration fault: workflow recovery sweeps are paused");
    }
    void sweepOrphanUploadDirs(dir).then((removed) => {
      if (removed > 0) {
        log.step(`Removed ${removed} orphan upload dir${removed === 1 ? "" : "s"} from ${dir}/uploads`);
      }
    }).catch((err) => {
      log.step(`Orphan upload-dir sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  let projectionReady = false;
  const stateDb = openStateDb(dir);
  try {
    // Incremental for unchanged sources, but includes every retained partition.
    // This is required after schema migrations invalidate legacy path-keyed
    // projections; rebuilding only today would make history appear empty.
    rebuildProjectionForAllDates(stateDb, { dir, includeDates: [dateLocal()] });
    projectionReady = true;
  } catch (err) {
    log.warn(`SQLite projection startup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (workflowMutationsAllowed()) {
    void resumeRecoverableOcrApprovals(dir)
      .then((count) => {
        if (count > 0) log.step(`Resumed ${count} durable OCR approval${count === 1 ? "" : "s"}`);
      })
      .catch((error) => {
        log.error(`Durable OCR approval recovery failed: ${errorMessage(error)}`);
      });
  }
  const staticDir = opts.serveStatic ? resolve(process.cwd(), "dist/dashboard") : undefined;
  const sharedDeps = {
    dir,
    stateDb,
    workflow,
    port,
    projectionReady,
    staticDir,
    screenshotsDir: opts.screenshotsDir,
    repoRoot,
  };
  const accessPolicy = createDashboardAccessPolicy({ port, bindHost: host });
  const honoApp = createDashboardHonoApp({ ...sharedDeps, accessPolicy });
  const requestListener = withTrustedRemoteAddress(getRequestListener(honoApp.fetch));

  const localServer: Server = createServer(requestListener);
  const sweepInterval = setInterval(() => {
    void scanFailurePatterns(stateDb, projectionReady, dir);
    if (workflowMutationsAllowed()) {
      void scanOrphanedQueueItems(dir);
      void resumeRecoverableOcrApprovals(dir).catch((error) => {
        log.error(`Durable OCR approval recovery sweep failed: ${errorMessage(error)}`);
      });
    }
    captureStore.sweepExpired();
  }, 15_000);
  sweepInterval.unref();
  const screenshotSweepInterval = setInterval(() => {
    runScreenshotSweep(dir, opts.screenshotsDir);
  }, 6 * 60 * 60 * 1000);
  screenshotSweepInterval.unref();
  // Debug-only: replay today's tracker JSONL into a per-row lifecycle trail
  // under .tracker/debug/row-lifecycle-<date>.{json,jsonl}. Off the hot
  // path, never streamed — see src/tracker/row-lifecycle-debug.ts.
  const rowLifecycleDebugInterval = setInterval(() => {
    runRowLifecycleDebugSweep(dir);
  }, 60_000);
  rowLifecycleDebugInterval.unref();
  const dependencyScheduler = startDependencyScheduler({
    trackerDir: dir,
    intervalMs: 1000,
    canRun: workflowMutationsAllowed,
    onError: (err) => log.warn(`[tasks] dependency scheduler tick failed: ${errorMessage(err)}`),
  });
  const stopBackgroundWork = (): void => {
    clearInterval(sweepInterval);
    clearInterval(screenshotSweepInterval);
    clearInterval(rowLifecycleDebugInterval);
    dependencyScheduler.stop();
  };
  localServer.on("close", () => stopBackgroundWork());

  localServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.step(`Dashboard port ${port} in use — skipping (another instance may be running)`);
      stopBackgroundWork();
      if (server === localServer) server = null;
    }
  });

  localServer.listen(port, host, () => {
    const addr = localServer.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    if (port !== 0) {
      log.step(`Live dashboard: http://${host}:${boundPort}`);
    }
  });

  if (opts.uploadPort != null) {
    const captureApp = createPublicCaptureHonoApp(sharedDeps);
    const uploadServer: Server = createServer(getRequestListener(captureApp.fetch));
    uploadServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.step(
          `Capture port ${opts.uploadPort} in use — phone Capture is unavailable until the port is free`,
        );
      }
    });
    const captureHost = resolveDashboardBindHost(opts.captureHost ?? host);
    uploadServer.listen(opts.uploadPort, captureHost, () => {
      if (opts.uploadPort !== 0) {
        log.step(`Token-scoped phone Capture: http://${captureHost}:${opts.uploadPort}`);
      }
    });
    localServer.on("close", () => {
      try {
        uploadServer.close();
      } catch {
        /* best-effort */
      }
    });
  }

  return localServer;
}

function runScreenshotSweep(dir: string, screenshotsDir: string | undefined): void {
  try {
    const result = sweepStaleRunScreenshots(dir, screenshotsDir ?? PATHS.screenshotDir);
    const total =
      result.terminalRunFilesDeleted + result.orphanFilesDeleted;
    if (total > 0) {
      log.step(
        `Screenshot sweep: pruned ${result.terminalRunFilesDeleted} terminal-run + ${result.orphanFilesDeleted} orphan PNG${total === 1 ? "" : "s"}`,
      );
    }
  } catch (err) {
    log.warn(`Screenshot sweep skipped: ${errorMessage(err)}`);
  }
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
