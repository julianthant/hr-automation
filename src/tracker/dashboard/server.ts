import { createServer, type Server } from "node:http";
import {
  cleanOldScreenshots,
  cleanOldTrackerFiles,
  DEFAULT_DIR,
} from "../jsonl.js";
import { sweepStuckOcrRows } from "../ocr-http.js";
import { sweepStuckOathUploadRows } from "../oath-upload-http.js";
import { sweepOrphanUploadDirs } from "../../scripts/ops/clean-tracker.js";
import { log } from "../../utils/log.js";
import { createDashboardRequestListener } from "./routes/index.js";
import { createBaseRoutes } from "./routes/base.js";
import { createEventsRoute } from "./routes/events.js";
import { createSearchRoutes } from "./routes/search.js";
import { createScreenshotRoutes } from "./routes/screenshots.js";
import { createSharePointRoutes } from "./routes/sharepoint.js";
import { createEnqueueRoute } from "./routes/enqueue.js";
import { createDaemonStopRoute } from "./routes/daemon-stop.js";
import { createOpsRoutes } from "./routes/ops.js";
import { createOcrRoutes } from "./routes/ocr.js";
import { createOathUploadRoutes } from "./routes/oath-upload.js";
import { createCaptureRoutes } from "./routes/capture.js";

let server: Server | null = null;

export interface StartDashboardOptions {
  noClean?: boolean;
  cleanMaxAgeDays?: number;
  dir?: string;
  uploadPort?: number | null;
}

export interface CreateDashboardServerOptions {
  workflow?: string;
  port?: number;
  dir?: string;
  noClean?: boolean;
  cleanMaxAgeDays?: number;
  uploadPort?: number | null;
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
  });
}

export function createDashboardServer(opts: CreateDashboardServerOptions = {}): Server {
  const workflow = opts.workflow ?? "onboarding";
  const port = opts.port ?? 3838;
  const dir = opts.dir ?? DEFAULT_DIR;

  if (!opts.noClean) {
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deleted = cleanOldTrackerFiles(maxAge);
      if (deleted > 0) {
        log.step(`Pruned ${deleted} tracker file${deleted === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Tracker startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deletedShots = cleanOldScreenshots(maxAge);
      if (deletedShots > 0) {
        log.step(`Pruned ${deletedShots} screenshot${deletedShots === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Screenshot startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    try {
      const removed = sweepOrphanUploadDirs(dir);
      if (removed > 0) {
        log.step(`Removed ${removed} orphan upload dir${removed === 1 ? "" : "s"} from ${dir}/uploads`);
      }
    } catch (err) {
      log.step(`Orphan upload-dir sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const requestListener = createDashboardRequestListener(
    { workflow, port, dir },
    [
      createBaseRoutes(),
      createEventsRoute(),
      createSearchRoutes(),
      createScreenshotRoutes(),
      createSharePointRoutes(),
      createEnqueueRoute(),
      createDaemonStopRoute(),
      createOpsRoutes(),
      createOcrRoutes(),
      createOathUploadRoutes(),
      createCaptureRoutes(),
    ],
  );

  const localServer: Server = createServer(requestListener);

  localServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.step(`Dashboard port ${port} in use — skipping (another instance may be running)`);
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

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
