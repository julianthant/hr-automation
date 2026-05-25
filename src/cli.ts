import { Command } from "commander";
import { createServer } from "vite";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { parsePositiveInt, requireEnv } from "./cli-helpers.js";
import { launchBrowser } from "./infra/browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./infra/auth/login.js";
import type { AuthResult } from "./infra/auth/types.js";
import "./workflows/ocr/index.js";
import { exportToExcel } from "./tracker/exports/export-excel.js";
import { startDashboard } from "./tracker/dashboard.js";
import { stopDaemons } from "./core/index.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

// ─── test-login ───

async function runAuthFlow(): Promise<AuthResult> {
  const result: AuthResult = { ucpath: false, actCrm: false };

  log.step("Starting UCPath authentication...");
  result.ucpath = await runLogin("UCPath", async () => {
    const ucpath = await launchBrowser();
    try {
      return await loginToUCPath(ucpath.page);
    } finally {
      await ucpath.browser?.close();
    }
  });
  if (!result.ucpath) {
    log.error("UCPath authentication failed");
    process.exit(1);
  }

  log.step("Starting ACT CRM authentication...");
  result.actCrm = await runLogin("ACT CRM", async () => {
    const actCrm = await launchBrowser();
    try {
      return await loginToACTCrm(actCrm.page);
    } finally {
      await actCrm.browser?.close();
    }
  });
  if (!result.actCrm) {
    log.error("ACT CRM authentication failed");
    process.exit(1);
  }

  log.success("Authentication complete");
  return result;
}

async function runLogin(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ok = await fn();
      if (ok) return true;
      log.warn(`${label} login attempt ${attempt} failed`);
    } catch (err) {
      log.warn(`${label} login attempt ${attempt} failed: ${errorMessage(err)}`);
    }
  }
  return false;
}

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .action(async () => {
    requireEnv();

    try {
      await runAuthFlow();
    } catch (err) {
      log.error(`Authentication failed: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── dashboard ───

program
  .command("dashboard")
  .description("Start the live monitoring dashboard (run in a separate terminal)")
  .option("-p, --port <port>", "SSE server port", (v) => parsePositiveInt(v, "--port"))
  .option("--prod", "Serve built dashboard instead of Vite dev server")
  .option("--no-clean", "Skip the one-time startup prune of old tracker files")
  .action(async (opts: { port?: number; prod?: boolean; clean?: boolean }) => {
    const port = opts.port ?? 3838;
    // Commander's --no-clean sets opts.clean === false; default is `undefined` → clean = true.
    startDashboard("all", port, {
      noClean: opts.clean === false,
      serveStatic: Boolean(opts.prod),
    });

    if (opts.prod) {
      // Production mode: serve built HTML from SSE server only
      log.success(`Dashboard running at http://localhost:${port}`);
      log.step("Press Ctrl+C to stop.");
    } else {
      // Dev mode: start Vite dev server with proxy to SSE backend
      const vite = await createServer({
        configFile: "vite.dashboard.config.ts",
        server: { open: true },
      });
      await vite.listen();
      vite.printUrls();
      log.step(`SSE backend on port ${port}`);
    }

    // Keep process alive
    await new Promise(() => {});
  });

// ─── export ───

program
  .command("export <workflow>")
  .description("Export JSONL tracker data to Excel")
  .option("-o, --output <path>", "Output file path")
  .action(async (workflow: string, opts: { output?: string }) => {
    await exportToExcel(workflow, opts.output);
  });

// ─── daemon lifecycle (stop only) ───

program
  .command("daemon-stop <workflow>")
  .description("Stop all alive daemons for a workflow. Default: soft (drain in-flight, re-queue on exit).")
  .option("-f, --force", "Mark in-flight items as failed instead of re-queueing")
  .action(async (workflow: string, opts: { force?: boolean }) => {
    const n = await stopDaemons(workflow, !!opts.force);
    console.log(`Sent stop to ${n} daemon(s) for '${workflow}'.`);
  });

program.parse();
