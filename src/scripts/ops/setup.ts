// First-use environment validation wizard.
//
// Runs a fixed sequence of checks to verify the operator's workstation can run
// any workflow. Each check prints one of [ok] / [warn] / [fail] with a fix
// suggestion. Exit 0 if all pass (or only warnings); exit 1 if any fail.
//
// Usage:
//   npm run setup
//
// Design notes:
//   * Never log env-var VALUES — only existence. `.env` is secrets.
//   * Keep each check small + synchronous (or await a quick process) so the
//     wizard finishes in a few seconds.
//   * macOS notification capability (`osascript`) is warn-only on non-darwin so
//     Linux/Windows operators aren't blocked.
//   * We do NOT use the `log` module here — the wizard output is its own thing,
//     and the log module would emit colored prefixes we don't want for checks.

import pc from "picocolors";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  /** Suggested remediation. Omitted when status is "ok". */
  fix?: string;
}

// ─── Individual check helpers (exported for testing) ──────────────────────────

/**
 * Check that a `.env` file exists and contains the two required keys. Never
 * reads or surfaces the values — only existence of the key prefix. Accepts a
 * custom cwd for test isolation.
 */
export function checkEnvFile(cwd: string = process.cwd()): CheckResult {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return {
      name: ".env file",
      status: "fail",
      message: "missing .env file",
      fix: "Copy .env.example to .env and fill in UCPATH_USER_ID + UCPATH_PASSWORD.",
    };
  }
  const contents = readFileSync(envPath, "utf-8");
  const required = ["UCPATH_USER_ID", "UCPATH_PASSWORD"];
  const missing = required.filter(
    // Match key at line start, optionally preceded by whitespace, followed by =.
    // We don't parse values — just confirm the key line is present.
    (key) => !new RegExp(`^\\s*${key}\\s*=`, "m").test(contents),
  );
  if (missing.length > 0) {
    return {
      name: ".env file",
      status: "fail",
      message: `missing keys: ${missing.join(", ")}`,
      fix: "Add the missing keys to .env (see .env.example for format).",
    };
  }
  return {
    name: ".env file",
    status: "ok",
    message: `found at ${envPath} with required keys`,
  };
}

/**
 * Check Node.js major version ≥ 20. Uses `process.versions.node` rather than
 * shelling out so the check works uniformly across Unix + Windows.
 */
export function checkNodeVersion(
  versionString: string = process.versions.node,
): CheckResult {
  const match = versionString.match(/^(\d+)\./);
  if (!match) {
    return {
      name: "Node.js version",
      status: "fail",
      message: `unrecognized node version: ${versionString}`,
      fix: "Install Node.js 20 or later from https://nodejs.org.",
    };
  }
  const major = Number(match[1]);
  if (major < 20) {
    return {
      name: "Node.js version",
      status: "fail",
      message: `node ${versionString} is too old (need ≥ 20)`,
      fix: "Install Node.js 20 or later from https://nodejs.org.",
    };
  }
  return {
    name: "Node.js version",
    status: "ok",
    message: `node v${versionString}`,
  };
}

/**
 * Confirm `tsx` is available via node_modules/.bin (which is how all npm
 * scripts in this repo invoke it). Falls back to `which tsx` for direct-cli
 * users. Pure filesystem check — never spawns the tool itself.
 */
export function checkTsx(cwd: string = process.cwd()): CheckResult {
  const localBin = path.join(
    cwd,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  if (existsSync(localBin)) {
    return {
      name: "tsx",
      status: "ok",
      message: `found at ${localBin}`,
    };
  }
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execSync(`${which} tsx`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      return {
        name: "tsx",
        status: "ok",
        message: `found on PATH at ${out.split("\n")[0]}`,
      };
    }
  } catch {
    /* fall through */
  }
  return {
    name: "tsx",
    status: "fail",
    message: "tsx not found in node_modules/.bin or on PATH",
    fix: "Run `npm install` to install devDependencies.",
  };
}

/**
 * Probe for Playwright chromium browsers. We don't run `npx playwright
 * install --dry-run` here (too slow + ambiguous); instead we just check the
 * platform's chromium cache directory. If no chromium-* subdir exists, the
 * browsers aren't installed yet.
 *
 * Cache locations:
 *   * darwin: ~/Library/Caches/ms-playwright
 *   * linux:  ~/.cache/ms-playwright
 *   * win32:  %USERPROFILE%/AppData/Local/ms-playwright
 *
 * Env override `PLAYWRIGHT_BROWSERS_PATH` takes precedence (Playwright honors
 * this as the cache root).
 */
export function checkPlaywrightBrowsers(
  homedir: string = os.homedir(),
  envOverride?: string,
): CheckResult {
  const override = envOverride ?? process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.platform === "darwin") {
    candidates.push(path.join(homedir, "Library", "Caches", "ms-playwright"));
  } else if (process.platform === "win32") {
    candidates.push(
      path.join(homedir, "AppData", "Local", "ms-playwright"),
    );
  } else {
    candidates.push(path.join(homedir, ".cache", "ms-playwright"));
  }
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      // Require at least one chromium-* subdirectory.
      const has = readdirSync(dir).some((f) => f.startsWith("chromium-"));
      if (has) {
        return {
          name: "Playwright chromium",
          status: "ok",
          message: `chromium installed in ${dir}`,
        };
      }
    } catch {
      /* unreadable dir — continue to next candidate */
    }
  }
  return {
    name: "Playwright chromium",
    status: "fail",
    message: "no chromium-* directory found in Playwright cache",
    fix: "Run `npx playwright install chromium` to install the browser.",
  };
}

/**
 * Verify a directory is writable by touching + deleting a temp file. Creates
 * the dir if missing (mkdir recursive). Returns `fail` on any I/O error, since
 * workflows cannot run without tracker + screenshot persistence.
 */
export function checkDirWritable(
  name: string,
  dir: string,
  fix: string,
): CheckResult {
  try {
    mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, `.setup-check-${Date.now()}.tmp`);
    writeFileSync(testFile, "ok");
    rmSync(testFile, { force: true });
    return {
      name,
      status: "ok",
      message: `writable at ${dir}`,
    };
  } catch (err) {
    return {
      name,
      status: "fail",
      message: `unable to write to ${dir}: ${(err as Error).message}`,
      fix,
    };
  }
}

/**
 * Check macOS notification capability. On non-darwin, emit a warning (not a
 * failure) — tracker notifications are nice-to-have, not required.
 */
export function checkNotifyCapability(): CheckResult {
  if (process.platform !== "darwin") {
    return {
      name: "macOS notifications",
      status: "warn",
      message: `not macOS (platform=${process.platform}); desktop notifications disabled`,
      fix: "No action needed unless you want desktop notifications.",
    };
  }
  try {
    execSync(`osascript -e 'return 1'`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    return {
      name: "macOS notifications",
      status: "ok",
      message: "osascript available — desktop notifications enabled",
    };
  } catch (err) {
    return {
      name: "macOS notifications",
      status: "warn",
      message: `osascript failed: ${(err as Error).message}`,
      fix: "System Integrity Protection may block osascript — notifications will be skipped.",
    };
  }
}

/**
 * Probe for `jq` on PATH. Used by a handful of operator scripts (diagnostic
 * JSONL greps). Warn-only — workflows don't depend on it.
 */
export function checkJq(): CheckResult {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execSync(`${which} jq`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      return {
        name: "jq (optional)",
        status: "ok",
        message: `found at ${out.split("\n")[0]}`,
      };
    }
  } catch {
    /* not found */
  }
  return {
    name: "jq (optional)",
    status: "warn",
    message: "jq not found on PATH",
    fix: "Install with `brew install jq` (macOS) — only needed for a few diagnostic scripts.",
  };
}

// ─── Telegram setup helpers ────────────────────────────────────────────────

/** Token validation outcome — narrows on `.ok`. */
export type TokenValidation =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/** Validate a BotFather-issued token. Format: `<digits>:<30+ chars>`. */
export function validateBotToken(input: string): TokenValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "token is empty" };
  }
  // BotFather tokens look like 7234567890:AAH-... — digits, colon, ~35 alphanum.
  const m = /^\d+:[A-Za-z0-9_-]{30,}$/.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      reason: "token does not match BotFather format (digits:alphanum)",
    };
  }
  return { ok: true, token: trimmed };
}

export type ChatIdDiscovery =
  | { ok: true; chatId: string }
  | { ok: false; reason: string };

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string } };
}

/**
 * Fetch /getUpdates and return the chat_id of the most recent message. Used
 * once during setup; afterwards the chat_id lives in .env. `fetchFn` is
 * injectable for tests.
 */
export async function discoverChatId(
  token: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<ChatIdDiscovery> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates`;
    const res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      result?: TelegramUpdate[];
    };
    if (!body.ok || !Array.isArray(body.result)) {
      return { ok: false, reason: "Telegram /getUpdates returned non-ok" };
    }
    const updates = body.result;
    if (updates.length === 0) {
      return {
        ok: false,
        reason:
          "no updates yet — message your bot once on Telegram, then re-run setup",
      };
    }
    // Most recent update is last in the array per Telegram's getUpdates docs.
    const latest = updates[updates.length - 1];
    const id = latest.message?.chat?.id;
    if (id === undefined || id === null) {
      return {
        ok: false,
        reason: "latest update has no message.chat.id (was it a channel post?)",
      };
    }
    return { ok: true, chatId: String(id) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Read or create the .env file in `cwd`, set or replace `key=value`.
 * Idempotent. Preserves trailing newline. Never logs the value.
 */
export function writeEnvVar(cwd: string, key: string, value: string): void {
  const envPath = path.join(cwd, ".env");
  let contents = "";
  if (existsSync(envPath)) {
    contents = readFileSync(envPath, "utf-8");
  }
  const lineRegex = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (lineRegex.test(contents)) {
    contents = contents.replace(lineRegex, line);
  } else {
    if (contents.length > 0 && !contents.endsWith("\n")) contents += "\n";
    contents += `${line}\n`;
  }
  writeFileSync(envPath, contents);
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * Run every check in order. Returns the results array so tests can inspect
 * shape without invoking the process-exit wrapper. Callers that want the
 * standard exit behavior should use `setupMain()`.
 */
export function runAllChecks(cwd: string = process.cwd()): CheckResult[] {
  return [
    checkEnvFile(cwd),
    checkNodeVersion(),
    checkTsx(cwd),
    checkPlaywrightBrowsers(),
    checkDirWritable(
      ".tracker/ directory",
      path.join(cwd, ".tracker"),
      "Check filesystem permissions in the repo root.",
    ),
    checkDirWritable(
      ".screenshots/ directory",
      path.join(cwd, ".screenshots"),
      "Check filesystem permissions in the repo root.",
    ),
    checkDirWritable(
      "~/Downloads/onboarding/",
      path.join(os.homedir(), "Downloads", "onboarding"),
      "Check filesystem permissions on your home directory.",
    ),
    checkNotifyCapability(),
    checkJq(),
  ];
}

function renderStatus(s: CheckStatus): string {
  if (s === "ok") return pc.green("[ok]  ");
  if (s === "warn") return pc.yellow("[warn]");
  return pc.red("[fail]");
}

/**
 * Pretty-print a results array. Returns the exit code (0 if all pass or only
 * warnings, 1 if any fails). Kept pure for testing.
 */
export function renderResults(results: CheckResult[]): {
  exitCode: number;
  output: string;
} {
  const lines: string[] = [];
  lines.push(pc.bold("HR Automation — environment check"));
  lines.push("");
  for (const r of results) {
    lines.push(`${renderStatus(r.status)}  ${pc.bold(r.name)} — ${r.message}`);
    if (r.fix && r.status !== "ok") {
      lines.push(`        ${pc.dim("fix:")} ${r.fix}`);
    }
  }
  lines.push("");
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  if (failed > 0) {
    lines.push(
      pc.red(
        `  ${failed} check${failed === 1 ? "" : "s"} failed — address the fix suggestions above.`,
      ),
    );
  } else if (warned > 0) {
    lines.push(
      pc.yellow(
        `  All required checks passed (${warned} warning${warned === 1 ? "" : "s"}). You can run any workflow.`,
      ),
    );
  } else {
    lines.push(
      pc.green(
        `  All ${results.length} checks passed. You're ready to run any workflow.`,
      ),
    );
  }
  lines.push("");
  return {
    exitCode: failed > 0 ? 1 : 0,
    output: lines.join("\n"),
  };
}

export function setupMain(): number {
  const results = runAllChecks();
  const { exitCode, output } = renderResults(results);
  console.log(output);
  return exitCode;
}

// Only run when invoked directly (not when imported by tests).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("setup.ts") ||
  process.argv[1]?.endsWith("setup.js");

if (isMainModule) {
  process.exit(setupMain());
}
