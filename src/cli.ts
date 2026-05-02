import { Command } from "commander";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { launchBrowser } from "./browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import { runOnboardingCli } from "./workflows/onboarding/index.js";
import { runWorkStudyCli, WorkStudyInputSchema } from "./workflows/work-study/index.js";
import { runEmergencyContactCli } from "./workflows/emergency-contact/index.js";
import { runParallelKronos, DEFAULT_WORKERS } from "./workflows/old-kronos-reports/index.js";
import { runSeparationCli } from "./workflows/separations/index.js";
import { runEidLookupCli } from "./workflows/eid-lookup/index.js";
import {
  runOathSignatureCli,
  OathSignatureInputSchema,
} from "./workflows/oath-signature/index.js";
import {
  runOathUploadCli,
  sha256OfFile,
} from "./workflows/oath-upload/index.js";
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

// ─── onboarding ───
//
// Daemon mode — enqueues to an alive onboarding daemon (or spawns one) so
// CRM + UCPath sessions stay warm across batches.

program
  .command("onboarding")
  .description(
    "Onboard one or more employees: extract from CRM, search UCPath, create transaction. " +
      "Daemon mode — sessions persist across invocations (no re-Duo).",
  )
  .argument("<emails...>", "Employee email(s)")
  .option("-n, --new", "Force spawn of a brand-new daemon (ignores alive ones for dispatch)")
  .option("-p, --parallel <N>", "Fan out across N daemons (reuses up to N alive; spawns the rest)", parseInt)
  .action(async (
    emails: string[],
    options: { new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (emails.length === 0) {
      log.error("Provide at least one email.");
      process.exit(1);
    }
    if (options.parallel !== undefined && (options.parallel < 1 || !Number.isFinite(options.parallel))) {
      log.error("--parallel must be a positive integer.");
      process.exit(1);
    }

    try {
      await runOnboardingCli(emails, { new: options.new, parallel: options.parallel });
    } catch (error) {
      log.error(`Onboarding failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── work-study ───

program
  .command("work-study")
  .description("Work study: update position pool via PayPath Actions. Daemon-mode — enqueues to an alive daemon or spawns one.")
  .argument("<emplId>", "Employee ID (e.g. 10862930)")
  .argument("<effectiveDate>", "Effective date in MM/DD/YYYY format")
  .option("-n, --new", "Spawn an additional daemon even if others are alive")
  .option("-p, --parallel <count>", "Ensure N daemons are alive", (v) => parseInt(v, 10))
  .action(async (
    emplId: string,
    effectiveDate: string,
    options: { new?: boolean; parallel?: number },
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
  .description("Fill Emergency Contact in UCPath for every record in a batch YAML (daemon mode)")
  .argument("<batchYaml>", "Path to batch YAML (e.g. .tracker/emergency-contact/batch-YYYY-MM-DD.yml)")
  .option("--roster-url <url>", "SharePoint URL of roster xlsx — downloaded + used for pre-flight verification")
  .option("--roster-path <path>", "Local roster xlsx for pre-flight verification (skip download)")
  .option("--ignore-roster-mismatch", "Continue even if roster verification reports mismatches")
  .option("-n, --new", "Spawn an additional daemon even if others are alive")
  .option("-p, --parallel <count>", "Ensure at least N daemons are alive before enqueueing", parseInt)
  .action(async (batchYaml: string, options: {
    rosterUrl?: string;
    rosterPath?: string;
    ignoreRosterMismatch?: boolean;
    new?: boolean;
    parallel?: number;
  }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      await runEmergencyContactCli(batchYaml, {
        rosterUrl: options.rosterUrl,
        rosterPath: options.rosterPath,
        ignoreRosterMismatch: options.ignoreRosterMismatch,
        new: options.new,
        parallel: options.parallel,
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
  .option("--start-date <date>", "Start date (M/DD/YYYY)")
  .option("--end-date <date>", "End date (M/DD/YYYY)")
  .action(async (options: {
    workers?: number;
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
  .description("Process employee separation(s): Kuali → Kronos → UCPath. Daemon-mode — enqueues docIds to an alive daemon or spawns one.")
  .argument("<docIds...>", "Kuali document number(s) (e.g. 3508 or 3881 3882 3883 3884)")
  .option("-n, --new", "Spawn an additional daemon even if others are alive")
  .option("-p, --parallel <count>", "Ensure N daemons are alive", (v) => parseInt(v, 10))
  .action(async (
    docIds: string[],
    options: { new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      await runSeparationCli(docIds, { new: options.new, parallel: options.parallel });
    } catch (error) {
      log.error(`Separation dispatch failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });

// ─── oath-signature ───

program
  .command("oath-signature")
  .alias("oath")
  .description(
    "Add a new Oath Signature Date to the UCPath Person Profile for one or " +
      "more EIDs. Daemon-mode — enqueues each EID to an alive daemon (or spawns one).",
  )
  .argument("<emplIds...>", "One or more employee IDs (e.g. 10873075 10862930)")
  .option("--date <MM/DD/YYYY>", "Override the signature date (default: UCPath prefills today)")
  .option("-n, --new", "Force spawn of a brand-new daemon (ignores alive ones for dispatch)")
  .option("-p, --parallel <N>", "Fan out across N daemons (reuses up to N alive; spawns the rest)", parseInt)
  .action(async (
    emplIds: string[],
    options: {
      date?: string;
      new?: boolean;
      parallel?: number;
    },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (emplIds.length === 0) {
      log.error("Provide at least one Empl ID.");
      process.exit(1);
    }
    if (options.parallel !== undefined && (options.parallel < 1 || !Number.isFinite(options.parallel))) {
      log.error("--parallel must be a positive integer.");
      process.exit(1);
    }

    // Validate every EID up front so a malformed tail doesn't fire Duo prompts.
    const inputs: Array<{ emplId: string; date?: string }> = [];
    for (const emplId of emplIds) {
      const parsed = OathSignatureInputSchema.safeParse({ emplId, date: options.date });
      if (!parsed.success) {
        log.error(
          `Invalid input for ${emplId}: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        );
        process.exit(1);
      }
      inputs.push(parsed.data);
    }

    try {
      await runOathSignatureCli(inputs, {
        new: options.new,
        parallel: options.parallel,
      });
    } catch (err) {
      log.error(`Oath Signature dispatch failed: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── oath-upload ───

program
  .command("oath-upload")
  .description(
    "Upload a paper-oath PDF; OCRs it, fans out N oath-signature transactions, " +
      "then files an HR Inquiry ticket on support.ucsd.edu. Daemon-mode — " +
      "amortizes ServiceNow Duo across uploads.",
  )
  .argument("<pdfPaths...>", "One or more PDF file paths")
  .option("-n, --new", "Force spawn of a brand-new daemon (ignores alive ones for dispatch)")
  .option("-p, --parallel <N>", "Fan out across N daemons (reuses up to N alive; spawns the rest)", parseInt)
  .action(async (
    pdfPaths: string[],
    options: { new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    if (pdfPaths.length === 0) {
      log.error("Provide at least one PDF path.");
      process.exit(1);
    }
    if (options.parallel !== undefined && (options.parallel < 1 || !Number.isFinite(options.parallel))) {
      log.error("--parallel must be a positive integer.");
      process.exit(1);
    }

    const { existsSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    // Validate every path up front (existence + readable) and pre-hash so a
    // malformed tail doesn't fire ServiceNow Duo prompts.
    const inputs: Array<{
      pdfPath: string;
      pdfOriginalName: string;
      sessionId: string;
      pdfHash: string;
      rosterMode: "existing" | "download";
      rosterPath?: string;
    }> = [];
    for (const p of pdfPaths) {
      if (!existsSync(p)) {
        log.error(`PDF not found: ${p}`);
        process.exit(1);
      }
      try {
        const hash = await sha256OfFile(p);
        inputs.push({
          pdfPath: p,
          pdfOriginalName: basename(p),
          sessionId: randomUUID(),
          pdfHash: hash,
          // CLI defaults to fresh SharePoint download; dashboard modal lets the
          // operator pick "use latest local" instead.
          rosterMode: "download",
        });
      } catch (err) {
        log.error(`Failed to hash ${p}: ${errorMessage(err)}`);
        process.exit(1);
      }
    }

    try {
      await runOathUploadCli(inputs, {
        new: options.new,
        parallel: options.parallel,
      });
    } catch (err) {
      log.error(`Oath Upload dispatch failed: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── eid-lookup ───

program
  .command("eid-lookup")
  .description("Look up Employee IDs by name via Person Organizational Summary (UCPath + CRM cross-verify). Daemon-mode — keeps UCPath+CRM sessions alive across batches (no re-Duo).")
  .argument("<names...>", 'One or more names in "Last, First Middle" format')
  .option("-n, --new", "Force spawn of a brand-new daemon (ignores alive ones for dispatch)")
  .option("-p, --parallel <N>", "Fan out across N daemons (reuses up to N alive; spawns the rest)", parseInt)
  .action(async (
    names: string[],
    options: { new?: boolean; parallel?: number },
  ) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }
    if (options.parallel !== undefined && (options.parallel < 1 || !Number.isFinite(options.parallel))) {
      log.error("--parallel must be a positive integer.");
      process.exit(1);
    }

    await runEidLookupCli(names, { new: options.new, parallel: options.parallel });
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
      import("./workflows/oath-signature/index.js"),
      import("./workflows/oath-upload/index.js"),
      import("./workflows/ocr/index.js"),
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

// ─── daemon lifecycle (stop only) ───

program
  .command("daemon-stop <workflow>")
  .description("Stop all alive daemons for a workflow. Default: soft (drain in-flight, re-queue on exit).")
  .option("-f, --force", "Mark in-flight items as failed instead of re-queueing")
  .action(async (workflow: string, opts: { force?: boolean }) => {
    const { stopDaemons } = await import("./core/index.js");
    const n = await stopDaemons(workflow, !!opts.force);
    console.log(`Sent stop to ${n} daemon(s) for '${workflow}'.`);
  });

program.parse();
