/**
 * Daemon entry point — exec'd by `src/core/daemon-registry.ts::spawnDaemon` in
 * a detached child process. argv shape: `tsx src/cli-daemon.ts <workflow>`.
 *
 * Responsibilities:
 *   1. Resolve the workflow module (lazy import keeps unrelated workflows from
 *      being pulled into the daemon for another workflow).
 *   2. Hand the registered workflow to `runWorkflowDaemon`, which owns the
 *      HTTP control surface, lockfile, session, and claim loop.
 *   3. Exit 0 on clean shutdown (SIGINT, SIGTERM, or POST /stop); exit 1 on
 *      unhandled error. Stdout/stderr are redirected to a per-daemon log file
 *      by the spawner (`.tracker/daemons/{workflow}-<ISO>.log`).
 *
 * Add new workflows to `WORKFLOWS` below AND register their daemon-mode CLI
 * adapter (`runXxxCli`) in their barrel; the CLI router in `src/cli.ts`
 * dispatches through the adapter, which in turn uses `ensureDaemonsAndEnqueue`
 * → `spawnDaemon` → this file.
 */
import { runWorkflowDaemon } from "./core/daemon.js";
import { log } from "./utils/log.js";
import type { RegisteredWorkflow } from "./core/types.js";

type AnyRegisteredWorkflow = RegisteredWorkflow<unknown, readonly string[]>;

const WORKFLOWS: Record<string, () => Promise<AnyRegisteredWorkflow>> = {
  separations: async () => {
    const mod = await import("./workflows/separations/index.js");
    return mod.separationsWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "work-study": async () => {
    const mod = await import("./workflows/work-study/index.js");
    return mod.workStudyWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // EID Lookup daemon runs the CRM-on variant (UCPath + CRM, no I-9) — that's
  // the default flag combo for `npm run eid-lookup`. --no-crm and --i9 route
  // to the legacy in-process path (see `runEidLookupCli` for the rationale).
  "eid-lookup": async () => {
    const mod = await import("./workflows/eid-lookup/index.js");
    return mod.eidLookupCrmWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // Onboarding daemon holds 3 browsers (CRM + UCPath + I9) per session with
  // 2 Duos (I9 is SSO no-2FA). Heaviest per-daemon resource cost, but biggest
  // re-Duo savings since CRM's Duo alone is ~30-60s. --dry-run and --batch
  // (reads batch.yaml) route to the legacy in-process path.
  onboarding: async () => {
    const mod = await import("./workflows/onboarding/index.js");
    return mod.onboardingWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // Oath Signature: single UCPath browser + 1 Duo. Handler is short (8
  // plan steps, ~15s/EID) so daemon mode's biggest win is batching N EIDs
  // without re-Duo.
  "oath-signature": async () => {
    const mod = await import("./workflows/oath-signature/index.js");
    return mod.oathSignatureWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // Emergency Contact: single UCPath browser + 1 Duo. Records arrive via
  // batch YAML in the CLI adapter; daemon processes each record as a
  // standalone queue item. `betweenItems: ["reset-browsers"]` in the kernel
  // config resets the UCPath page between records.
  "emergency-contact": async () => {
    const mod = await import("./workflows/emergency-contact/index.js");
    return mod.emergencyContactWorkflow as unknown as AnyRegisteredWorkflow;
  },
};

async function main(): Promise<void> {
  const workflowName = process.argv[2];
  if (!workflowName) {
    log.error("cli-daemon: missing workflow name argument");
    process.exit(1);
  }
  const loader = WORKFLOWS[workflowName];
  if (!loader) {
    log.error(
      `cli-daemon: unknown workflow '${workflowName}' (registered: ${Object.keys(WORKFLOWS).join(", ")})`,
    );
    process.exit(1);
  }
  const workflow = await loader();
  await runWorkflowDaemon(workflow);
  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`cli-daemon: fatal ${msg}`);
  if (err instanceof Error && err.stack) log.error(err.stack);
  process.exit(1);
});
