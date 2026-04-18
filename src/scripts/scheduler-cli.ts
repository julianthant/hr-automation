/**
 * Thin CLI wrapper around `src/scheduler.ts`.
 *
 * Usage:
 *   tsx src/scripts/scheduler-cli.ts [--config schedule.yaml] [--dry-run] [--help]
 *
 * `--help` prints supported schedule syntax and exits 0 without scheduling.
 * `--dry-run` loads + parses the config and prints each entry's computed
 * next-run time, then exits 0 without scheduling. Useful for verifying a
 * `schedule.yaml` before letting the scheduler run unattended.
 *
 * With no flag, enters the long-running scheduler loop which fires
 * `npm run <workflow> [-- <args...>]` per entry until SIGINT/SIGTERM.
 */

import path from "node:path";
import {
  loadScheduleConfig,
  parseSchedule,
  runScheduler,
} from "../scheduler.js";

interface Args {
  config: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  let config = "schedule.yaml";
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const next = argv[++i];
      if (!next) {
        console.error("--config requires a path argument");
        process.exit(1);
      }
      config = next;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a) {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { config, dryRun, help };
}

function printHelp(): void {
  console.log(
    [
      "Usage: scheduler-cli [--config PATH] [--dry-run] [--help]",
      "",
      "  --config PATH   Schedule YAML (default: schedule.yaml)",
      "  --dry-run       Load + parse the config, print next-run times, exit 0",
      "  --help, -h      Print this help and exit 0",
      "",
      "Supported schedule specs (local time, not UTC):",
      "  daily HH:MM              Every day at HH:MM",
      "  weekly <dow> HH:MM       Every <dow> at HH:MM.",
      "                           <dow> is a comma-separated list of",
      "                           mon,tue,wed,thu,fri,sat,sun",
      "  interval <N>m or <N>h    Every N minutes or hours",
      "",
      "Examples:",
      "  daily 08:00",
      "  weekly mon 08:00",
      "  weekly mon,thu 08:00",
      "  interval 1h",
      "  interval 30m",
      "",
      "YAML entry shape:",
      "  - name: <human label>",
      "    workflow: <package.json script name>",
      "    args: [<arg1>, <arg2>, ...]   # optional",
      "    schedule: <one of the specs above>",
      "    enabled: true                 # optional (default true)",
      "",
      "On fire, the scheduler runs: npm run <workflow> [-- <args...>]",
    ].join("\n")
  );
}

function runDryRun(configPath: string): number {
  console.log(`[scheduler-cli] --dry-run: loading ${configPath}`);
  const config = loadScheduleConfig(configPath);
  const now = new Date();
  console.log(`[scheduler-cli] now: ${now.toISOString()}`);
  console.log(`[scheduler-cli] ${config.length} entries:`);
  for (const entry of config) {
    const enabledFlag = entry.enabled ? "enabled" : "disabled";
    try {
      const parsed = parseSchedule(entry.schedule);
      const next = parsed.nextRunAfter(now);
      console.log(
        `  - ${entry.name} [${enabledFlag}]\n` +
          `      workflow: npm run ${entry.workflow}${entry.args.length > 0 ? " -- " + entry.args.join(" ") : ""}\n` +
          `      schedule: ${entry.schedule}\n` +
          `      next run: ${next.toISOString()} (local: ${next.toLocaleString()})`
      );
    } catch (err) {
      console.error(
        `  - ${entry.name} [${enabledFlag}]: INVALID schedule '${entry.schedule}': ${(err as Error).message}`
      );
      return 1;
    }
  }
  return 0;
}

export async function schedulerCliMain(
  argv: string[] = process.argv.slice(2)
): Promise<number> {
  const { config, dryRun, help } = parseArgs(argv);

  if (help) {
    printHelp();
    return 0;
  }

  const configPath = path.resolve(config);

  if (dryRun) {
    return runDryRun(configPath);
  }

  // Long-running scheduler. SIGINT/SIGTERM inside runScheduler triggers clean
  // shutdown of any in-flight child and exit.
  await runScheduler(configPath);
  return 0;
}

// Only run when invoked directly (not when imported by tests).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("scheduler-cli.ts") ||
  process.argv[1]?.endsWith("scheduler-cli.js");

if (isMainModule) {
  schedulerCliMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[scheduler-cli] error: ${(err as Error).message}`);
      process.exit(1);
    });
}
