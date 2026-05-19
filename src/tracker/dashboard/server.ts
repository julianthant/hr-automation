import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import {
  cleanOldTrackerFiles,
  DEFAULT_DIR,
  dateLocal,
} from "../jsonl.js";
import { sweepStuckOcrRows } from "./ocr/index.js";
import { sweepStuckOathUploadRows } from "./oath-upload/http.js";
import { openStateDb } from "../state/db.js";
import { rebuildProjectionForDate } from "../state/rebuild.js";
import { startDependencyScheduler } from "../tasks/scheduler.js";
import { sweepOrphanUploadDirs } from "../../scripts/ops/clean-tracker.js";
import { sweepStaleRunScreenshots } from "../state/screenshot-sweep.js";
import { PATHS } from "../../config.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { createDashboardHonoApp } from "./hono/app.js";
import {
  scanFailurePatterns,
  scanOrphanedQueueItems,
} from "./sweeps.js";

let server: Server | null = null;

export interface StartDashboardOptions {
  noClean?: boolean;
  cleanMaxAgeDays?: number;
  dir?: string;
  screenshotsDir?: string;
  uploadPort?: number | null;
  serveStatic?: boolean;
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
  });
}

export function createDashboardServer(opts: CreateDashboardServerOptions = {}): Server {
  const workflow = opts.workflow ?? "onboarding";
  const port = opts.port ?? 3838;
  const dir = opts.dir ?? DEFAULT_DIR;

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
    rebuildProjectionForDate(stateDb, { dir, date: dateLocal() });
    projectionReady = true;
  } catch (err) {
    log.warn(`SQLite projection startup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  const staticDir = opts.serveStatic ? resolve(process.cwd(), "dist/dashboard") : undefined;
  const honoApp = createDashboardHonoApp({
    dir,
    stateDb,
    workflow,
    port,
    projectionReady,
    staticDir,
    screenshotsDir: opts.screenshotsDir,
  });
  const requestListener = getRequestListener(honoApp.fetch);

  const localServer: Server = createServer(requestListener);
  const sweepInterval = setInterval(() => {
    void scanFailurePatterns();
    void scanOrphanedQueueItems(dir);
  }, 15_000);
  const screenshotSweepInterval = setInterval(() => {
    runScreenshotSweep(dir, opts.screenshotsDir);
  }, 6 * 60 * 60 * 1000);
  screenshotSweepInterval.unref();
  const dependencyScheduler = startDependencyScheduler({
    trackerDir: dir,
    intervalMs: 1000,
    onError: (err) => log.warn(`[tasks] dependency scheduler tick failed: ${errorMessage(err)}`),
  });
  const stopBackgroundWork = (): void => {
    clearInterval(sweepInterval);
    clearInterval(screenshotSweepInterval);
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

  localServer.listen(port, () => {
    const addr = localServer.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    if (port !== 0) {
      log.step(`Live dashboard: http://localhost:${boundPort}`);
    }
  });

  if (opts.uploadPort != null) {
    const uploadServer: Server = createServer(requestListener);
    uploadServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.step(
          `Upload port ${opts.uploadPort} in use — uploads will fall back to main port (may queue behind SSE)`,
        );
      }
    });
    uploadServer.listen(opts.uploadPort, () => {
      if (opts.uploadPort !== 0) {
        log.step(`Upload listener: http://localhost:${opts.uploadPort}`);
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
