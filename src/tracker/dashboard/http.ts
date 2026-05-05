import type { IncomingMessage, ServerResponse } from "node:http";

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

export function jsonHeaders(opts: { fullCors?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (opts.fullCors) {
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return headers;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 64_536,
): Promise<JsonBodyResult> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
      if (Buffer.concat(chunks).byteLength > maxBytes) {
        return { ok: false, error: "Request body too large" };
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return { ok: true, body: {} };
    return { ok: true, body: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

export function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  opts: { fullCors?: boolean } = {},
): void {
  res.writeHead(statusCode, jsonHeaders(opts));
  res.end(JSON.stringify(body));
}

export function writeCorsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

export function writeSseHeaders(
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
}
