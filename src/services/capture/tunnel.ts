import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../../utils/log.js";

/**
 * Pure: extract the ASSIGNED quick-tunnel hostname from cloudflared output.
 *
 * The trap that caused a 404: cloudflared prints its own API host
 * `https://api.trycloudflare.com` in ordinary log/error lines (e.g. the
 * registration POST, or "failed to request quick Tunnel: Post
 * https://api.trycloudflare.com/tunnel …"). A naive `https://*.trycloudflare.com`
 * match grabs THAT and every request 404s. We exclude `api.` and take the first
 * real assigned subdomain (the `https://<words>.trycloudflare.com` shown in the
 * "Your quick Tunnel has been created!" banner).
 */
export function extractQuickTunnelUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  if (!matches) return undefined;
  return matches.find((u) => !u.startsWith("https://api."));
}

export interface QuickTunnel {
  url: string;
  /** Terminate the cloudflared process backing this tunnel. Idempotent. */
  stop: () => void;
}

export interface StartQuickTunnelOptions {
  /** Seconds to wait for a URL per attempt before giving up. Default 30. */
  attemptTimeoutSec?: number;
  /** Registration-failure retries (the anonymous endpoint is occasionally flaky). Default 2. */
  retries?: number;
}

/**
 * Start an ANONYMOUS Cloudflare quick tunnel to `http://localhost:<port>`.
 *
 * Fully isolated from `~/.cloudflared` (`--config /dev/null --origincert
 * /dev/null` + `TUNNEL_ORIGIN_CERT=/dev/null`), so it can NEVER pick up a
 * pre-existing named tunnel / account cert — every run is a fresh throwaway
 * `https://*.trycloudflare.com`. Retries on the transient "failed to request
 * quick Tunnel" registration timeout.
 *
 * Resolves with the URL + a `stop()`, or `null` when cloudflared is missing
 * (ENOENT) or every attempt failed — the caller then leaves the QR on the LAN
 * fallback (with the reachability warning) rather than blocking the dashboard.
 */
export async function startQuickTunnel(
  port: number,
  opts: StartQuickTunnelOptions = {},
): Promise<QuickTunnel | null> {
  const attemptTimeoutSec = opts.attemptTimeoutSec ?? 30;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tunnel = await runOneAttempt(port, attemptTimeoutSec);
    if (tunnel) return tunnel;
    if (attempt < retries) {
      log.warn(`capture tunnel: attempt ${attempt + 1} failed to register — retrying…`);
    }
  }
  return null;
}

function runOneAttempt(port: number, timeoutSec: number): Promise<QuickTunnel | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "cloudflared",
        [
          "tunnel",
          "--no-autoupdate",
          "--config", "/dev/null",
          "--origincert", "/dev/null",
          "--url", `http://localhost:${port}`,
        ],
        {
          env: { ...process.env, TUNNEL_ORIGIN_CERT: "/dev/null" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      resolve(null);
      return;
    }

    let buf = "";
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutSec * 1000);

    function finish(result: QuickTunnel | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      if (result) {
        // Keep the process alive but drain its pipes so cloudflared never
        // blocks on backpressure. Log an unexpected death (tunnel lost).
        child.stdout?.resume();
        child.stderr?.resume();
        child.on("exit", (code) =>
          log.warn(`capture tunnel: cloudflared exited (code ${code ?? "?"}) — QR links will stop working`),
        );
      } else {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      resolve(result);
    }

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const url = extractQuickTunnelUrl(buf);
      if (url) {
        finish({
          url,
          stop: () => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          },
        });
      } else if (/failed to request quick Tunnel/i.test(buf)) {
        finish(null); // registration timed out — let startQuickTunnel retry
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => finish(null)); // ENOENT: cloudflared not installed
    child.on("exit", () => finish(null)); // died before emitting a URL
  });
}
