import { Command } from "commander";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { launchBrowser } from "./browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import { runOnboarding, runParallel, runOnboardingPositional } from "./workflows/onboarding/index.js";
import { runWorkStudy, runWorkStudyCli, WorkStudyInputSchema } from "./workflows/work-study/index.js";
import { runEmergencyContact } from "./workflows/emergency-contact/index.js";
import { runParallelKronos, DEFAULT_WORKERS } from "./workflows/old-kronos-reports/index.js";
import { runSeparation, runSeparationBatch, runSeparationCli } from "./workflows/separations/index.js";
import { runEidLookup } from "./workflows/eid-lookup/index.js";
import { exportToExcel } from "./tracker/export-excel.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

// ─── test-login ───

async function runAuthFlow(): Promise<AuthResult> {
  const result: AuthResult = { ucpath: false, actCrm: false };

  log.step("Starting UCPath authentication...");
  const ucpath = await launchBrowser();
  try {
    const ok = await loginToUCPath(ucpath.page);
    if (!ok) {
      log.error("UCPath authentication failed");
      await ucpath.browser?.close();
      process.exit(1);
    }
    result.ucpath = true;
  } finally {
    await ucpath.browser?.close();
  }

  log.step("Starting ACT CRM authentication...");
  const actCrm = await launchBrowser();
  try {
    const ok = await loginToACTCrm(actCrm.page);
    if (!ok) {
      log.error("ACT CRM authentication failed");
      await actCrm.browser?.close();
      process.exit(1);
    }
    result.actCrm = true;
  } finally {
    await actCrm.browser?.close();
  }

  log.success("Authentication complete");
  return result;
}

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .action(async () => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      await runAuthFlow();
    } catch (firstError) {
      log.error("Unexpected error -- retrying...");
      try {
        await runAuthFlow();
      } catch (secondError) {
        log.error(`Authentication failed after retry: ${errorMessage(secondError)}`);
        process.exit(1);
      }
    }
  });

// ─── start-onboarding ───

program
  .command("start-onboarding")
  .description("Start onboarding: extract from CRM, search UCPath, create transaction")
  .argument("[email]", "Employee email (for single-employee mode)")
  .option("--dry-run", "Preview actions without creating transaction")
  .option("--parallel <N>", "Process batch file with N parallel workers", parseInt)
  .action(async (email: string | undefined, options: { dryRun?: boolean; parallel?: number }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    // Validate: exactly one of email or --parallel
    if (email && options.parallel) {
      log.error("Cannot use both email and --parallel. Use email for single mode, --parallel for batch mode.");
      process.exit(1);
    }
    if (!email && !options.parallel) {
      log.error("Provide an email for single mode or --parallel <N> for batch mode.");
      process.exit(1);
    }

    if (options.parallel) {
      if (options.parallel < 1 || !Number.isFinite(options.parallel)) {
        log.error("--parallel must be a positive integer.");
        process.exit(1);
      }
      await runParallel(options.parallel, { dryRun: options.dryRun });
    } else {
      await runOnboarding(email!, { dryRun: options.dryRun });
    }
  });

// ─── onboarding (positional emails) ───

program
  .command("onboarding")
  .description("Run onboarding for one or more emails (positional). Pool size = min(N, 4), override with --workers.")
  .argument("<emails...>", "Employee email(s)")
  .option("--dry-run", "Preview without running")
  .option("--workers <N>", "Pool size override", parseInt)
  .action(async (emails: string[], options: { dryRun?: boolean; workers?: number }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (options.workers !== undefined && (options.workers < 1 || !Number.isFinite(options.workers))) {
      log.error("--workers must be a positive integer.");
      process.exit(1);
    }

    try {
      await runOnboardingPositional(emails, { dryRun: options.dryRun, poolSize: options.workers });
    } catch (error) {
      log.error(`Onboarding failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── work-study ───

program
  .command("work-study")
  .description("Work study: update position pool via PayPath Actions. Daemon-mode by default — enqueues to an alive daemon or spawns one. Use --direct for the legacy in-process single-item path.")
  .argument("<emplId>", "Employee ID (e.g. 10862930)")
  .argument("<effectiveDate>", "Effective date in MM/DD/YYYY format")
  .option("--dry-run", "Preview actions without submitting")
  .option("--direct", "Bypass daemon mode and run in-process (legacy — blocks on auth each run)")
  .option("-n, --new", "Spawn an additional daemon even if others are alive")
  .option("-p, --parallel <count>", "Ensure N daemons are alive", (v) => parseInt(v, 10))
  .action(async (
    emplId: string,
    effectiveDate: string,
    options: { dryRun?: boolean; direct?: boolean; new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    const parsed = WorkStudyInputSchema.safeParse({ emplId, effectiveDate });
    if (!parsed.success) {
      log.error(`Invalid input: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
      process.exit(1);
    }

    if (options.direct || options.dryRun) {
      await runWorkStudy(parsed.data, { dryRun: options.dryRun });
      return;
    }

    try {
      await runWorkStudyCli(parsed.data.emplId, parsed.data.effectiveDate, {
        new: options.new,
        parallel: options.parallel,
      });
    } catch (err) {
      log.error(`Work study dispatch failed: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── emergency-contact ───

program
  .command("emergency-contact")
  .description("Fill Emergency Contact in UCPath for every record in a batch YAML")
  .argument("<batchYaml>", "Path to batch YAML (e.g. .tracker/emergency-contact/batch-YYYY-MM-DD.yml)")
  .option("--dry-run", "Preview records without touching UCPath")
  .option("--roster-url <url>", "SharePoint URL of roster xlsx — downloaded + used for pre-flight verification")
  .option("--roster-path <path>", "Local roster xlsx for pre-flight verification (skip download)")
  .option("--ignore-roster-mismatch", "Continue even if roster verification reports mismatches")
  .action(async (batchYaml: string, options: {
    dryRun?: boolean;
    rosterUrl?: string;
    rosterPath?: string;
    ignoreRosterMismatch?: boolean;
  }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      await runEmergencyContact(batchYaml, {
        dryRun: options.dryRun,
        rosterUrl: options.rosterUrl,
        rosterPath: options.rosterPath,
        ignoreRosterMismatch: options.ignoreRosterMismatch,
      });
    } catch (err) {
      log.error(`Emergency Contact batch failed: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── kronos ───

program
  .command("kronos")
  .description("Download Time Detail PDF reports from UKG for employees in batch.yaml")
  .option("--workers <N>", "Number of parallel workers", parseInt)
  .option("--dry-run", "Preview employee list without downloading")
  .option("--start-date <date>", "Start date (M/DD/YYYY)")
  .option("--end-date <date>", "End date (M/DD/YYYY)")
  .action(async (options: {
    workers?: number;
    dryRun?: boolean;
    startDate?: string;
    endDate?: string;
  }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    const workers = options.workers ?? DEFAULT_WORKERS;
    if (workers < 1 || !Number.isFinite(workers)) {
      log.error("--workers must be a positive integer.");
      process.exit(1);
    }

    try {
      await runParallelKronos(workers, {
        dryRun: options.dryRun,
        startDate: options.startDate,
        endDate: options.endDate,
      });
    } catch (error) {
      log.error(`Kronos workflow failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── separation ───

program
  .command("separation")
  .alias("separations")
  .description("Process employee separation(s): Kuali → Kronos → UCPath. Daemon-mode by default — enqueues docIds to an alive daemon or spawns one. Use --direct for the legacy in-process batch path.")
  .argument("<docIds...>", "Kuali document number(s) (e.g. 3508 or 3881 3882 3883 3884)")
  .option("--dry-run", "Extract data only, don't fill forms")
  .option("--direct", "Bypass daemon mode and run in-process (legacy — reopens browsers + re-auths every invocation)")
  .option("-n, --new", "Spawn an additional daemon even if others are alive")
  .option("-p, --parallel <count>", "Ensure N daemons are alive", (v) => parseInt(v, 10))
  .action(async (
    docIds: string[],
    options: { dryRun?: boolean; direct?: boolean; new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (options.direct) {
      if (docIds.length === 1) {
        try {
          await runSeparation(docIds[0], { dryRun: options.dryRun });
          log.success(`Separation complete for doc #${docIds[0]}`);
        } catch (error) {
          log.error(`Separation workflow failed: ${errorMessage(error)}`);
          process.exit(1);
        }
        return;
      }
      log.step(`Batch mode (direct): ${docIds.length} separations — ${docIds.join(", ")}`);
      try {
        const result = await runSeparationBatch(docIds, { dryRun: options.dryRun });
        log.success(`Batch complete: ${result.succeeded}/${result.total} succeeded`);
        if (result.failed > 0) process.exit(1);
      } catch (error) {
        log.error(`Separation batch failed: ${errorMessage(error)}`);
        process.exit(1);
      }
      return;
    }

    try {
      await runSeparationCli(docIds, {
        dryRun: options.dryRun,
        new: options.new,
        parallel: options.parallel,
      });
    } catch (error) {
      log.error(`Separation dispatch failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── eid-lookup ───

program
  .command("eid-lookup")
  .description("Look up Employee IDs by name via Person Organizational Summary (UCPath, optional CRM cross-verify, optional I-9 Section 2 signer lookup)")
  .argument("<names...>", 'One or more names in "Last, First Middle" format')
  .option("--workers <N>", "Number of parallel browser tabs (default: min(names.length, 4))", parseInt)
  .option("--no-crm", "Skip CRM cross-verification (UCPath only)")
  .option("--i9", "Also look up who signed Section 2 in I-9 Complete")
  .option("-d, --dry-run", "Preview the planned name list without launching a browser")
  .action(async (names: string[], options: { workers?: number; crm?: boolean; i9?: boolean; dryRun?: boolean }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }
    if (options.workers !== undefined && (options.workers < 1 || !Number.isFinite(options.workers))) {
      log.error("--workers must be a positive integer.");
      process.exit(1);
    }
    // Commander's --no-crm flag surfaces as `options.crm === false`; default true.
    const useCrm = options.crm !== false;
    const useI9 = options.i9 === true;
    await runEidLookup(names, {
      workers: options.workers,
      useCrm,
      useI9,
      dryRun: options.dryRun,
    });
  });

// ─── dashboard ───

program
  .command("dashboard")
  .description("Start the live monitoring dashboard (run in a separate terminal)")
  .option("-p, --port <port>", "SSE server port", parseInt)
  .option("--prod", "Serve built dashboard instead of Vite dev server")
  .option("--no-clean", "Skip the one-time startup prune of old tracker files")
  .action(async (opts: { port?: number; prod?: boolean; clean?: boolean }) => {
    // Trigger workflow metadata registration for every workflow — the dashboard's
    // /api/workflow-definitions endpoint reads from the registry, and that
    // registry is populated at module load via defineWorkflow (kernel) /
    // defineDashboardMetadata (legacy). Without these side-effect imports the
    // dashboard would only know about whichever workflow the user just ran.
    await Promise.all([
      import("./workflows/onboarding/index.js"),
      import("./workflows/separations/index.js"),
      import("./workflows/work-study/index.js"),
      import("./workflows/eid-lookup/index.js"),
      import("./workflows/emergency-contact/index.js"),
      import("./workflows/old-kronos-reports/index.js"),
    ]);

    const { startDashboard } = await import("./tracker/dashboard.js");
    const port = opts.port ?? 3838;
    // Commander's --no-clean sets opts.clean === false; default is `undefined` → clean = true.
    startDashboard("all", port, { noClean: opts.clean === false });

    if (opts.prod) {
      // Production mode: serve built HTML from SSE server only
      log.success(`Dashboard running at http://localhost:${port}`);
      log.step("Press Ctrl+C to stop.");
    } else {
      // Dev mode: start Vite dev server with proxy to SSE backend
      const { createServer } = await import("vite");
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

// ─── daemon lifecycle (applies to any daemon-mode workflow) ───

const DAEMON_WORKFLOWS = ["separations", "work-study"] as const;

program
  .command("daemon-status [workflow]")
  .description("Show alive daemons + queue state. Without [workflow] lists every daemon-enabled workflow.")
  .action(async (workflow?: string) => {
    const { findAliveDaemons, readQueueState } = await import("./core/index.js");
    const workflows = workflow ? [workflow] : [...DAEMON_WORKFLOWS];
    for (const wf of workflows) {
      const alive = await findAliveDaemons(wf);
      const state = await readQueueState(wf).catch(() => null);
      console.log(`\n[${wf}]`);
      if (alive.length === 0) console.log("  no alive daemons");
      for (const d of alive) {
        console.log(
          `  ${d.instanceId}  pid=${d.pid}  port=${d.port}  startedAt=${d.startedAt}`,
        );
      }
      if (state) {
        console.log(
          `  queue: queued=${state.queued.length} claimed=${state.claimed.length} done=${state.done.length} failed=${state.failed.length}`,
        );
      }
    }
  });

program
  .command("daemon-stop <workflow>")
  .description("Stop all alive daemons for a workflow. Default: soft (drain in-flight, re-queue on exit).")
  .option("-f, --force", "Mark in-flight items as failed instead of re-queueing")
  .action(async (workflow: string, opts: { force?: boolean }) => {
    const { stopDaemons } = await import("./core/index.js");
    const n = await stopDaemons(workflow, !!opts.force);
    console.log(`Sent stop to ${n} daemon(s) for '${workflow}'.`);
  });

program
  .command("daemon-attach <workflow>")
  .description("Tail logs of every alive daemon for a workflow. Ctrl+C detaches; daemons keep running.")
  .action(async (workflow: string) => {
    const { findAliveDaemons, daemonsDir } = await import("./core/index.js");
    const alive = await findAliveDaemons(workflow);
    if (alive.length === 0) {
      console.log(`No alive daemons for '${workflow}'.`);
      return;
    }
    const { spawn } = await import("node:child_process");
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = daemonsDir();
    if (!existsSync(dir)) {
      console.log("no .tracker/daemons dir");
      return;
    }
    const logs = readdirSync(dir).filter((f) => f.startsWith(`${workflow}-`) && f.endsWith(".log"));
    if (logs.length === 0) {
      console.log(`no log files in ${dir}`);
      return;
    }
    const tail = spawn("tail", ["-f", ...logs.map((l) => join(dir, l))], { stdio: "inherit" });
    tail.on("exit", () => process.exit(0));
  });

program.parse();
