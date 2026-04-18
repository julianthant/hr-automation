import { exec } from "node:child_process";
import { log } from "../utils/log.js";

/**
 * Escape a string for safe interpolation inside single quotes on the shell
 * command line. Only strictly needed because `osascript -e '...'` uses single
 * quotes; the double quotes inside the AppleScript source are encoded by us,
 * not by the shell.
 */
function shellEscape(s: string): string {
  // Close the quote, emit an escaped single quote, reopen. Classic POSIX.
  return s.replace(/'/g, "'\\''");
}

/**
 * Escape a string for embedding inside AppleScript string literals. AppleScript
 * strings are double-quoted — we need to escape `"` and `\`. Newlines become
 * spaces because `display notification` doesn't render them usefully.
 */
function appleScriptEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

/**
 * Fire a desktop notification. Best-effort — on non-darwin or when `osascript`
 * fails we log to console via `log.warn` and return without throwing.
 *
 * Uses macOS's built-in `osascript` to issue an AppleScript `display
 * notification` command. No native deps, no npm packages.
 *
 * Parameters are sanitized for both shell and AppleScript literal contexts.
 * Avoid excessively long `body` strings — macOS truncates after ~250 chars.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (process.platform !== "darwin") {
    log.warn(`notify (non-darwin, skipped): ${title} — ${body}`);
    return;
  }
  const safeTitle = shellEscape(appleScriptEscape(title));
  const safeBody = shellEscape(appleScriptEscape(body));
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  const cmd = `osascript -e '${script}'`;
  await new Promise<void>((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        // Log & move on — a notification failure should never derail the dashboard.
        log.warn(`notify failed (osascript): ${err.message}`);
      }
      resolve();
    });
  });
}
