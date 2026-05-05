import { createReadStream, statSync } from "node:fs";

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

export function textResponse(
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function streamFileResponse(
  path: string,
  opts: {
    contentType: string;
    cacheControl: string;
    disposition?: string;
  },
): Response {
  const stat = statSync(path);
  return new Response(createReadStream(path) as unknown as BodyInit, {
    headers: {
      "Content-Type": opts.contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": opts.cacheControl,
      "Access-Control-Allow-Origin": "*",
      ...(opts.disposition ? { "Content-Disposition": opts.disposition } : {}),
    },
  });
}

export async function readJsonRequest(
  request: Request,
  maxBytes = 64_536,
): Promise<JsonBodyResult> {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      return { ok: false, error: "Request body too large" };
    }
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, body: {} };
    return { ok: true, body: JSON.parse(trimmed) as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}
