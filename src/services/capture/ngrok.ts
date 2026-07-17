import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../../utils/log.js";

export interface NgrokTunnel {
  url: string;
  /** Terminate the ngrok process backing this tunnel. Idempotent. */
  stop: () => void;
}

export interface StartNgrokTunnelOptions {
  /** Milliseconds to wait for ngrok to print its public URL. Default 20s. */
  timeoutMs?: number;
  /** Optional static ngrok URL/domain, passed through to `ngrok http --url`. */
  url?: string;
}

/**
 * Pure: extract the assigned public URL from ngrok v3 JSON logs.
 *
 * We start ngrok with `--log stdout --log-format json`; the load-bearing event
 * is `{ msg:"started tunnel", url:"https://..." }`. Parsing only that field
 * avoids accidentally grabbing local API/status URLs from other log lines.
 */
export function extractNgrokTunnelUrl(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseNgrokJsonLine(raw);
    if (!parsed) continue;
    const record = parsed as { msg?: unknown; url?: unknown };
    if (
      record.msg === "started tunnel" &&
      typeof record.url === "string" &&
      /^https?:\/\//i.test(record.url)
    ) {
      return record.url.replace(/\/+$/, "");
    }
  }
  return undefined;
}

/** Pure: extract the most relevant ngrok startup error from JSON logs. */
export function extractNgrokError(text: string): string | undefined {
  let latest: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseNgrokJsonLine(raw);
    if (!parsed) continue;
    const record = parsed as { err?: unknown; lvl?: unknown; msg?: unknown };
    if (typeof record.err !== "string" || record.err === "<nil>") continue;
    if (record.lvl === "eror" || record.lvl === "crit" || record.msg === "command failed") {
      latest = summarizeNgrokError(record.err);
    }
  }
  return latest;
}

function parseNgrokJsonLine(raw: string): unknown {
  const line = raw.trim();
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeNgrokError(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 397)}...` : oneLine;
}

/**
 * Start an ngrok HTTP tunnel to `http://localhost:<port>`.
 *
 * Resolves with the public URL + a stop handle, or `null` when ngrok is missing
 * or cannot establish a tunnel before the timeout. Callers should treat `null`
 * as fatal for Capture; LAN fallbacks are intentionally disabled.
 */
export function startNgrokTunnel(
  port: number,
  opts: StartNgrokTunnelOptions = {},
): Promise<NgrokTunnel | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    const args = [
      "http",
      String(port),
      "--log",
      "stdout",
      "--log-format",
      "json",
      "--log-level",
      "info",
    ];
    if (opts.url) args.push("--url", opts.url);

    let child: ChildProcess;
    try {
      child = spawn("ngrok", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }

    let buf = "";
    let lastError: string | undefined;
    let settled = false;
    let stopping = false;
    const timer = setTimeout(() => finish(null), timeoutMs);

    function stopChild(): void {
      stopping = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }

    function finish(result: NgrokTunnel | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      if (result) {
        child.stdout?.resume();
        child.stderr?.resume();
        child.on("exit", (code) => {
          if (!stopping) {
            log.warn(
              `capture ngrok: process exited (code ${code ?? "?"}) — QR links will stop working`,
            );
          }
        });
      } else {
        if (lastError) {
          log.warn(`capture ngrok: ${lastError}`);
        }
        stopChild();
      }
      resolve(result);
    }

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      lastError = extractNgrokError(buf) ?? lastError;
      const url = extractNgrokTunnelUrl(buf);
      if (url) {
        finish({ url, stop: stopChild });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => finish(null)); // ENOENT: ngrok not installed
    child.on("exit", () => finish(null)); // died before emitting a URL
  });
}
