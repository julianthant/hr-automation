import { Command } from "commander";
import { createServer } from "vite";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { parsePositiveInt, requireEnv } from "./cli-helpers.js";
import { launchBrowser } from "./infra/browser/launch.js";
import { DUO_LOGIN_FLOWS } from "./infra/auth/duo-login-flows.js";
import { isDuoWebAuthnEnabled } from "./infra/auth/duo-webauthn.js";
import "./workflows/ocr/index.js";
import { exportToExcel } from "./tracker/exports/export-excel.js";
import { startDashboard } from "./tracker/dashboard.js";
import { stopDaemons } from "./core/index.js";
import { startNgrokTunnel, type NgrokTunnel } from "./services/capture/ngrok.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

// ─── test-login ───

// `DUO_LOGIN_FLOWS` (the seven UCSD Shibboleth/Duo SSO flows) lives in
// `src/infra/auth/duo-login-flows.ts` — shared with the live auth test.

const DEFAULT_DUO_FLOW_KEYS = ["ucpath", "crm"];

function resolveDuoFlows(opts: {
  all?: boolean;
  systems?: string;
}): typeof DUO_LOGIN_FLOWS {
  if (opts.all) return DUO_LOGIN_FLOWS;
  const requested = opts.systems
    ? opts.systems.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_DUO_FLOW_KEYS;
  const known = new Set(DUO_LOGIN_FLOWS.map((f) => f.key));
  const unknown = requested.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown system(s): ${unknown.join(", ")}. Valid: ${DUO_LOGIN_FLOWS.map((f) => f.key).join(", ")}`,
    );
  }
  return DUO_LOGIN_FLOWS.filter((f) => requested.includes(f.key));
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

/**
 * Run the selected Duo SSO flows, each in a fresh browser, and print a
 * per-system pass/fail table. Returns true only if every flow passed. Unlike a
 * fail-fast loop, every flow is attempted so one failure doesn't mask the rest.
 */
async function runAuthSweep(flows: typeof DUO_LOGIN_FLOWS): Promise<boolean> {
  const handsOff = isDuoWebAuthnEnabled();
  log.step(
    `Testing ${flows.length} Duo SSO flow(s): ${flows.map((f) => f.label).join(", ")} | hands-off WebAuthn: ${handsOff ? "ON" : "OFF (manual Duo)"}`,
  );

  const results: Array<{ label: string; ok: boolean }> = [];
  for (const flow of flows) {
    log.step(`Starting ${flow.label} authentication...`);
    const ok = await runLogin(flow.label, async () => {
      const session = await launchBrowser();
      try {
        return await flow.run(session.page);
      } finally {
        await session.browser?.close();
      }
    });
    results.push({ label: flow.label, ok });
  }

  log.step("── Duo login results ──");
  for (const r of results) {
    if (r.ok) log.success(`  PASS  ${r.label}`);
    else log.error(`  FAIL  ${r.label}`);
  }
  return results.every((r) => r.ok);
}

program
  .command("test-login")
  .description(
    "Test UCSD SSO + Duo authentication. Default: UCPath + ACT CRM. " +
      "Set HR_AUTOMATION_DUO_WEBAUTHN=1 to verify hands-off WebAuthn approval.",
  )
  .option(
    "--all",
    "Test every Duo SSO flow (UCPath, CRM, UKG, Kuali, New Kronos, ServiceNow)",
  )
  .option(
    "--systems <list>",
    "Comma-separated subset: ucpath,crm,ukg,kuali,newkronos,servicenow,onbase,i9",
  )
  .action(async (opts: { all?: boolean; systems?: string }) => {
    requireEnv();

    try {
      const flows = resolveDuoFlows(opts);
      const ok = await runAuthSweep(flows);
      if (!ok) {
        log.error("One or more Duo logins failed");
        process.exit(1);
      }
      log.success("Authentication complete");
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
  .option("--host <host>", "Dashboard bind host (non-loopback also requires HRAUTO_DASHBOARD_ALLOW_LAN=1)")
  .option("--prod", "Serve built dashboard instead of Vite dev server")
  .option("--no-clean", "Skip the one-time startup prune of old tracker files")
  .option("--capture-ngrok", "Start ngrok and use its public URL for phone Capture QR links")
  .option("--capture-ngrok-url <url>", "Optional static ngrok URL/domain to pass to ngrok --url")
  .action(
    async (opts: {
      port?: number;
      prod?: boolean;
      clean?: boolean;
      captureNgrok?: boolean;
      captureNgrokUrl?: string;
      host?: string;
    }) => {
    // Dashboard runs default to hands-off Duo. Without it, a daemon login
    // (person-lookup, oath-signature, …) stalls on Duo's native "insert your
    // security key and touch it" dialog — Duo defaults to the security-key
    // factor once the hands-off WebAuthn key is enrolled, and the native dialog
    // blocks the page with nothing to answer it, so the run hangs at auth.
    // Setting the flag arms the enrolled virtual key so the prompt auto-approves;
    // spawned daemons inherit it via `{ ...process.env }` (daemon/registry.ts),
    // which is where auth actually happens. Falls back to manual Duo cleanly when
    // `.auth/duo-webauthn.json` is absent. Set HR_AUTOMATION_DUO_WEBAUTHN=0 to
    // force manual approval.
    if (process.env.HR_AUTOMATION_DUO_WEBAUTHN === undefined) {
      process.env.HR_AUTOMATION_DUO_WEBAUTHN = "1";
    }
    const handsOffDuo = process.env.HR_AUTOMATION_DUO_WEBAUTHN === "1";
    const port = opts.port ?? 3838;
    log.step(
      handsOffDuo
        ? "Hands-off Duo ON — daemon logins auto-approve via the enrolled WebAuthn key (set HR_AUTOMATION_DUO_WEBAUTHN=0 to require manual approval)."
        : "Hands-off Duo OFF — daemon logins require manual Duo approval.",
    );

    const captureNgrokUrl = opts.captureNgrokUrl ?? process.env.CAPTURE_NGROK_URL;
    const shouldStartNgrok =
      Boolean(opts.captureNgrok || captureNgrokUrl || process.env.CAPTURE_NGROK === "1");
    if (shouldStartNgrok) {
      if (process.env.CAPTURE_PUBLIC_URL) {
        log.step(
          `CAPTURE_PUBLIC_URL=${process.env.CAPTURE_PUBLIC_URL} will be replaced by the ngrok URL for this dashboard process.`,
        );
      }
      const capturePort = port + 1;
      log.step(`Starting ngrok tunnel for Capture: https://ngrok → http://127.0.0.1:${capturePort}`);
      const captureNgrokTunnel = await startNgrokTunnel(capturePort, { url: captureNgrokUrl });
      if (captureNgrokTunnel) {
        process.env.CAPTURE_PUBLIC_URL = captureNgrokTunnel.url;
        registerTunnelCleanup(captureNgrokTunnel);
        log.success(`Capture QR will use ngrok URL ${captureNgrokTunnel.url}`);
      } else {
        log.error(
          "Capture ngrok tunnel did not start. Capture requires ngrok or CAPTURE_PUBLIC_URL; no LAN fallback will be used. Check `ngrok config check` / your auth token and restart.",
        );
        process.exit(1);
      }
    }

    // No public URL configured at all: the dashboard still serves — Capture
    // degrades loudly instead of blocking startup. /api/capture/start already
    // fails with a 503 when publicUrl is absent (src/services/capture/server.ts),
    // so no QR can ever encode a LAN URL. Only an explicitly requested ngrok
    // tunnel that FAILED (handled above) remains a hard startup error.
    if (!process.env.CAPTURE_PUBLIC_URL) {
      log.warn(
        "Capture disabled: no public URL (start with --capture-ngrok or set CAPTURE_PUBLIC_URL). /api/capture/start will return 503; everything else works.",
      );
    }

    // Commander's --no-clean sets opts.clean === false; default is `undefined` → clean = true.
    startDashboard("all", port, {
      noClean: opts.clean === false,
      serveStatic: Boolean(opts.prod),
      // Honor the isolated-tracker env on the dashboard itself, not just spawned
      // daemons — otherwise HRAUTO_E2E_STUBS runs write rows/state.db into the
      // real `.tracker/` while daemons write the isolated root (split-brain).
      dir: process.env.HRAUTO_TRACKER_DIR,
      host: opts.host,
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

    if (process.env.CAPTURE_PUBLIC_URL) {
      log.step(`Capture QR will use CAPTURE_PUBLIC_URL=${process.env.CAPTURE_PUBLIC_URL}`);
    }

    // Keep process alive
    await new Promise(() => {});
  });

function registerTunnelCleanup(tunnel: NgrokTunnel): void {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    tunnel.stop();
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
}

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
