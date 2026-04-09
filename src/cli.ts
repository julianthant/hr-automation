import { Command } from "commander";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { launchBrowser } from "./browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import { runOnboarding, runParallel } from "./workflows/onboarding/index.js";
import { runWorkStudy, WorkStudyInputSchema } from "./workflows/work-study/index.js";
import { runParallelKronos, DEFAULT_WORKERS } from "./workflows/old-kronos-reports/index.js";
import { runSeparation } from "./workflows/separations/index.js";
import { lookupSingle, lookupParallel } from "./workflows/eid-lookup/index.js";
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
  .description("Process employee separation: Kuali → Kronos → UCPath")
  .argument("<docId>", "Kuali document number (e.g. 3508)")
  .option("--dry-run", "Extract data only, don't fill forms")
  .action(async (docId: string, options: { dryRun?: boolean }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      const { data } = await runSeparation(docId, { dryRun: options.dryRun });
      log.success(`Separation complete for ${data.employeeName} (EID: ${data.eid})`);
    } catch (error) {
      log.error(`Separation workflow failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── eid-lookup ───

program
  .command("eid-lookup")
  .description("Look up Employee IDs by name via Person Organizational Summary")
  .argument("<names...>", 'One or more names in "Last, First Middle" format')
  .option("--workers <N>", "Number of parallel browser tabs", parseInt)
  .action(async (names: string[], options: { workers?: number }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (names.length === 1 && !options.workers) {
      // Single lookup
      const result = await lookupSingle(names[0]);
      if (!result.found) process.exit(1);
    } else {
      // Parallel lookup
      const workers = options.workers ?? Math.min(names.length, 4);
      if (workers < 1 || !Number.isFinite(workers)) {
        log.error("--workers must be a positive integer.");
        process.exit(1);
      }
      const results = await lookupParallel(names, workers);
      const failed = results.filter((r) => !r.found);
      if (failed.length > 0) {
        log.error(`${failed.length} of ${names.length} lookups failed`);
        process.exit(1);
      }
    }
  });

// ─── dashboard ───

program
  .command("dashboard")
  .description("Start the live monitoring dashboard (run in a separate terminal)")
  .option("-p, --port <port>", "Port number", parseInt)
  .action(async (opts: { port?: number }) => {
    const { startDashboard } = await import("./tracker/dashboard.js");
    const port = opts.port ?? 3838;
    startDashboard("all", port);
    log.success(`Dashboard running at http://localhost:${port}`);
    log.step("Press Ctrl+C to stop.");
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
