import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

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

/** Above this, serve via Readable.toWeb — raw fs.ReadStream as BodyInit breaks Node 26 + Vite proxy. */
const STREAM_FILE_BUFFER_BYTES = 32 * 1024 * 1024;

export async function streamFileResponse(
  path: string,
  opts: {
    contentType: string;
    cacheControl: string;
    disposition?: string;
  },
): Promise<Response> {
  const stat = statSync(path);
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Content-Length": String(stat.size),
    "Cache-Control": opts.cacheControl,
    "Access-Control-Allow-Origin": "*",
    ...(opts.disposition ? { "Content-Disposition": opts.disposition } : {}),
  };

  if (stat.size <= STREAM_FILE_BUFFER_BYTES) {
    const buf = await readFile(path);
    return new Response(buf, { headers });
  }

  const webBody = Readable.toWeb(createReadStream(path));
  return new Response(webBody as unknown as BodyInit, { headers });
}

export async function readJsonRequest(
  request: Request,
  maxBytes = 64_536,
): Promise<JsonBodyResult> {
  // Fast-path: reject before buffering when Content-Length is declared and
  // already exceeds the limit. Content-Length is client-supplied; the
  // Buffer.byteLength check below handles cases where it's absent.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    return { ok: false, error: "Request body too large" };
  }
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
