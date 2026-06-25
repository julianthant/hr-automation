#!/usr/bin/env node
// Open a playwright-cli browser session with Duo Autopilot loaded, for headless
// selector mapping against UCSD's auth-gated systems. The extension answers the
// Duo WebAuthn ceremony itself (no phone, no headed step), so a login can run
// unattended; you still fill the SSO username/password (e.g. from .env).
//
// Usage:
//   node duo-autopilot/launch-selector-browser.mjs [url] [--headed]
//   npm run sel:browser -- <url>            # headless (default)
//   npm run sel:browser -- <url> --headed   # watch it
//
// After this returns, the session stays alive — drive it with the normal CLI:
//   playwright-cli -s=sel snapshot
//   playwright-cli -s=sel close             # always close when done
//
// Notes:
//   - Uses Playwright's bundled Chromium (browserName: chromium), which still
//     honours --load-extension; Google Chrome stable disabled that flag in 2024.
//     Install once with: playwright-cli install-browser chromium
//   - The credential is auto-imported by the extension's service worker from
//     duo-autopilot/credentials/duo-webauthn.json (gitignored). No file there →
//     the extension loads but stays unarmed and Duo falls back to your phone.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(fileURLToPath(import.meta.url)); // .../duo-autopilot
const repoRoot = resolve(extDir, "..");
const session = process.env.SEL_SESSION || "sel";

const rest = process.argv.slice(2);
const headed = rest.includes("--headed");
const url = rest.find((a) => !a.startsWith("--"));

const configDir = join(repoRoot, ".playwright");
const profileDir = join(repoRoot, ".auth", `${session}-profile`);
mkdirSync(configDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

// Generated, machine-specific (absolute paths) — gitignored via .playwright/.
const configPath = join(configDir, "duo-autopilot.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      browser: {
        browserName: "chromium",
        launchOptions: {
          // channel:chromium = full Chromium + new headless (the lightweight
          // headless-shell can't run extensions; verified required 2026-06-24).
          channel: "chromium",
          args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
        },
      },
    },
    null,
    2,
  ),
);

const cliArgs = [
  `-s=${session}`,
  "open",
  "--persistent", // extensions require a persistent context
  `--profile=${profileDir}`,
  `--config=${configPath}`,
];
if (headed) cliArgs.push("--headed");
if (url) cliArgs.push(url);

console.log(
  `Opening playwright-cli session '${session}' with Duo Autopilot loaded (${headed ? "headed" : "headless"})...`,
);

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit" });
}

let r = run("playwright-cli", cliArgs);
if (r.error && r.error.code === "ENOENT") {
  // Fall back to a locally-installed copy.
  r = run("npx", ["--no-install", "playwright-cli", ...cliArgs]);
}
if (r.error) {
  console.error(`Failed to launch playwright-cli: ${r.error.message}`);
  process.exit(1);
}
if (r.status === 0) {
  console.log(
    `\nSession '${session}' is live. Next:\n` +
      `  playwright-cli -s=${session} goto <url>\n` +
      `  playwright-cli -s=${session} snapshot\n` +
      `  playwright-cli -s=${session} close   # when done`,
  );
}
process.exit(r.status ?? 0);
