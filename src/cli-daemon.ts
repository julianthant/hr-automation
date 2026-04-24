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
import { loadWorkflow, listWorkflowNames } from "./core/workflow-loaders.js";

async function main(): Promise<void> {
  const workflowName = process.argv[2];
  if (!workflowName) {
    log.error("cli-daemon: missing workflow name argument");
    process.exit(1);
  }
  const workflow = await loadWorkflow(workflowName);
  if (!workflow) {
    log.error(
      `cli-daemon: unknown workflow '${workflowName}' (registered: ${listWorkflowNames().join(", ")})`,
    );
    process.exit(1);
  }
  await runWorkflowDaemon(workflow);
  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`cli-daemon: fatal ${msg}`);
  if (err instanceof Error && err.stack) log.error(err.stack);
  process.exit(1);
});
