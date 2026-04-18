import { Command } from "commander";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { launchBrowser } from "./browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import { runOnboarding, runParallel } from "./workflows/onboarding/index.js";
import { runWorkStudy, WorkStudyInputSchema } from "./workflows/work-study/index.js";
import { runEmergencyContact } from "./workflows/emergency-contact/index.js";
import { runParallelKronos, DEFAULT_WORKERS } from "./workflows/old-kronos-reports/index.js";
import { runSeparation } from "./workflows/separations/index.js";
import { trackEvent, readEntries } from "./tracker/jsonl.js";
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

// ─── work-study ───

program
  .command("work-study")
  .description("Work study: update position pool via PayPath Actions")
  .argument("<emplId>", "Employee ID (e.g. 10862930)")
  .argument("<effectiveDate>", "Effective date in MM/DD/YYYY format")
  .option("--dry-run", "Preview actions without submitting")
  .action(async (emplId: string, effectiveDate: string, options: { dryRun?: boolean }) => {
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

    await runWorkStudy(parsed.data, { dryRun: options.dryRun });
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
  .description("Process employee separation(s): Kuali → Kronos → UCPath. Multiple IDs = batch mode (shared browsers, sequential processing).")
  .argument("<docIds...>", "Kuali document number(s) (e.g. 3508 or 3881 3882 3883 3884)")
  .option("--dry-run", "Extract data only, don't fill forms")
  .action(async (docIds: string[], options: { dryRun?: boolean }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (docIds.length === 1) {
      // Single mode — original behavior
      try {
        const { data } = await runSeparation(docIds[0], { dryRun: options.dryRun });
        log.success(`Separation complete for ${data.employeeName} (EID: ${data.eid})`);
      } catch (error) {
        log.error(`Separation workflow failed: ${errorMessage(error)}`);
        process.exit(1);
      }
      return;
    }

    // Batch mode — pre-emit pending for all, then process sequentially
    log.step(`Batch mode: ${docIds.length} separations — ${docIds.join(", ")}`);

    const runIds = new Map<string, string>();
    const existing = readEntries("separations");
    for (const docId of docIds) {
      const priorRuns = new Set(existing.filter((e) => e.id === docId).map((e) => e.runId));
      const runId = `${docId}#${priorRuns.size + 1}`;
      runIds.set(docId, runId);
      trackEvent({
        workflow: "separations",
        timestamp: new Date().toISOString(),
        id: docId,
        runId,
        status: "pending",
        data: {},
      });
    }

    let existingWindows: import("./workflows/separations/index.js").SessionWindows | undefined;
    let failed = 0;

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      log.step(`\n=== Document ${i + 1}/${docIds.length}: #${docId} ===`);
      try {
        const result = await runSeparation(docId, {
          dryRun: options.dryRun,
          keepOpen: i < docIds.length - 1,
          existingWindows,
          runId: runIds.get(docId),
        });
        existingWindows = result.windows;
        log.success(`Doc #${docId} complete: ${result.data.employeeName} (EID: ${result.data.eid})`);
      } catch (error) {
        log.error(`Doc #${docId} failed: ${errorMessage(error)}`);
        failed++;
      }
    }

    log.success(`\nBatch complete: ${docIds.length - failed}/${docIds.length} succeeded`);
    if (failed > 0) process.exit(1);
  });

// ─── eid-lookup ───

program
  .command("eid-lookup")
  .description("Look up Employee IDs by name via Person Organizational Summary (UCPath, optional CRM cross-verify)")
  .argument("<names...>", 'One or more names in "Last, First Middle" format')
  .option("--workers <N>", "Number of parallel browser tabs (default: min(names.length, 4))", parseInt)
  .option("--no-crm", "Skip CRM cross-verification (UCPath only)")
  .option("-d, --dry-run", "Preview the planned name list without launching a browser")
  .action(async (names: string[], options: { workers?: number; crm?: boolean; dryRun?: boolean }) => {
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
    await runEidLookup(names, {
      workers: options.workers,
      useCrm,
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

program.parse();
