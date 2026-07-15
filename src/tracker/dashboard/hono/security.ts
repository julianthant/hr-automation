import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";

import { log } from "../../../utils/log.js";
import { jsonResponse } from "./responses.js";

export const OPERATOR_TOKEN_HEADER = "x-hr-auto-operator-token";
export const REMOTE_ADDRESS_HEADER = "x-hr-auto-remote-address";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface DashboardAccessPolicy {
  operatorToken: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  lanPassword?: string;
}

export interface DashboardAccessPolicyOptions {
  port: number;
  bindHost: string;
  devOrigin?: string;
  extraOrigins?: readonly string[];
  operatorToken?: string;
  lanPassword?: string;
}

function normalizeHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim().toLowerCase();
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (ipv6) return ipv6[1];
  return value.replace(/:\d+$/, "");
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Dashboard origin must use http or https: ${value}`);
  }
  return url.origin;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${OPERATOR_TOKEN_HEADER}`,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function forbidden(message: string): Response {
  return jsonResponse({ ok: false, error: message }, 403);
}

function unauthorizedLan(): Response {
  return jsonResponse({ ok: false, error: "Dashboard LAN authentication required" }, 401, {
    "WWW-Authenticate": 'Basic realm="HR Automation Dashboard", charset="UTF-8"',
  });
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return true;
  const address = value.trim().toLowerCase().replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function basicPassword(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "operator") return undefined;
  return decoded.slice(separator + 1);
}

function requestOrigin(c: Context): string | undefined {
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return "invalid";
  }
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateRequestTarget(urlValue: string): string | undefined {
  const url = new URL(urlValue);
  for (const encoded of url.pathname.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return "Request path contains invalid encoding";
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      return "Request path contains an invalid component";
    }
  }
  for (const workflow of url.searchParams.getAll("workflow")) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workflow)) return "Invalid workflow id";
  }
  for (const date of url.searchParams.getAll("date")) {
    if (!validCalendarDate(date)) return "Invalid date";
  }
  return undefined;
}

function auditPath(path: string): string {
  return path
    .replace(/(\/capture\/)[^/]+/g, "$1<redacted>")
    .replace(/(\/api\/capture\/manifest\/)[^/]+/g, "$1<redacted>")
    .replace(/(\/api\/files\/)[^/]+/g, "$1<redacted>");
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function resolveDashboardBindHost(
  requested = process.env.HRAUTO_DASHBOARD_HOST ?? "127.0.0.1",
  allowLan = process.env.HRAUTO_DASHBOARD_ALLOW_LAN === "1",
): string {
  const host = requested.trim().toLowerCase();
  if (!host) throw new Error("Dashboard host cannot be empty");
  if (!isLoopbackHost(host) && !allowLan) {
    throw new Error(
      `Refusing to bind dashboard to non-loopback host ${requested}; set HRAUTO_DASHBOARD_ALLOW_LAN=1 explicitly`,
    );
  }
  return requested.trim();
}

export function createDashboardAccessPolicy(
  opts: DashboardAccessPolicyOptions,
): DashboardAccessPolicy {
  const configuredOrigins = [
    ...(process.env.HRAUTO_DASHBOARD_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...(opts.extraOrigins ?? []),
  ];
  const allowedOrigins = new Set<string>([
    normalizeOrigin(`http://localhost:${opts.port}`),
    normalizeOrigin(`http://127.0.0.1:${opts.port}`),
    normalizeOrigin(opts.devOrigin ?? process.env.HRAUTO_DASHBOARD_DEV_ORIGIN ?? "http://localhost:5173"),
    ...configuredOrigins.map(normalizeOrigin),
  ]);
  const allowedHosts = new Set(LOOPBACK_HOSTS);
  if (opts.bindHost !== "0.0.0.0" && opts.bindHost !== "::") {
    allowedHosts.add(opts.bindHost.toLowerCase());
  }
  for (const origin of allowedOrigins) allowedHosts.add(new URL(origin).hostname.toLowerCase());
  const lanPassword = opts.lanPassword ?? process.env.HRAUTO_DASHBOARD_LAN_PASSWORD;
  if (!isLoopbackHost(opts.bindHost) && (!lanPassword || lanPassword.length < 16)) {
    throw new Error(
      "LAN dashboard binding requires HRAUTO_DASHBOARD_LAN_PASSWORD with at least 16 characters",
    );
  }
  return {
    operatorToken: opts.operatorToken ?? randomBytes(32).toString("base64url"),
    allowedOrigins,
    allowedHosts,
    ...(lanPassword ? { lanPassword } : {}),
  };
}

/**
 * Main dashboard boundary. Read access is limited to configured local hosts and
 * origins; every mutation additionally requires the per-process operator token.
 */
export function dashboardAccessMiddleware(policy: DashboardAccessPolicy): MiddlewareHandler {
  return async (c, next) => {
    const remoteIsLan = !isLoopbackAddress(c.req.header(REMOTE_ADDRESS_HEADER));
    if (remoteIsLan) {
      const supplied = basicPassword(c.req.header("authorization"));
      if (!policy.lanPassword || !tokenMatches(supplied, policy.lanPassword)) {
        return unauthorizedLan();
      }
    }
    const host = normalizeHostname(c.req.header("host") ?? new URL(c.req.url).host);
    if (!host || !policy.allowedHosts.has(host)) {
      return forbidden("Dashboard host is not allowed");
    }

    const origin = requestOrigin(c);
    if (origin && !policy.allowedOrigins.has(origin)) {
      return forbidden("Dashboard origin is not allowed");
    }

    const targetError = validateRequestTarget(c.req.url);
    if (targetError) return jsonResponse({ ok: false, error: targetError }, 400);

    if (c.req.method === "OPTIONS") {
      if (!origin) return forbidden("CORS preflight requires an Origin header");
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (MUTATION_METHODS.has(c.req.method)) {
      const supplied = c.req.header(OPERATOR_TOKEN_HEADER);
      if (!tokenMatches(supplied, policy.operatorToken)) {
        log.warn(`[dashboard-security] rejected unauthenticated ${c.req.method} ${auditPath(c.req.path)}`);
        return jsonResponse({ ok: false, error: "Operator authentication required" }, 401);
      }
    }

    await next();
    if (origin) {
      for (const [name, value] of Object.entries(corsHeaders(origin))) {
        c.header(name, value);
      }
    }
    if (MUTATION_METHODS.has(c.req.method)) {
      log.debug(`[dashboard-audit] ${c.req.method} ${auditPath(c.req.path)} -> ${c.res.status}`);
    }
  };
}

export function registerOperatorSessionRoute(
  app: Hono,
  policy: DashboardAccessPolicy,
): void {
  app.get("/api/operator/session", () =>
    jsonResponse({ token: policy.operatorToken, header: OPERATOR_TOKEN_HEADER }, 200, {
      "Cache-Control": "no-store",
    }));
}

/** Public Capture accepts only the phone endpoints and only its configured origin. */
export function publicCaptureCorsMiddleware(publicUrl: string | undefined): MiddlewareHandler {
  const allowedOrigin = publicUrl ? normalizeOrigin(publicUrl) : undefined;
  return async (c, next) => {
    const origin = requestOrigin(c);
    if (origin && origin !== allowedOrigin) return forbidden("Capture origin is not allowed");
    if (c.req.method === "OPTIONS") {
      if (!origin || !allowedOrigin) return forbidden("Capture origin is not allowed");
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    await next();
    if (origin && allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Vary", "Origin");
    }
  };
}
