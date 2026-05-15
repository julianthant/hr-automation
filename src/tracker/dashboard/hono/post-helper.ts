import type { Context } from "hono";

import { jsonResponse, readJsonRequest } from "./responses.js";

type ParseFailure = { ok: false; error: string; status?: number };
type OpsResult = { ok: boolean; status?: number };

function isParseFailure(value: unknown): value is ParseFailure {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false &&
      typeof (value as { error?: unknown }).error === "string",
  );
}

export async function postJson<T extends OpsResult, B>(
  c: Context,
  parse: (body: Record<string, unknown>) => B | ParseFailure,
  handler: (body: B) => Promise<T> | T,
  status: number | ((result: T) => number) = 200,
): Promise<Response> {
  const body = await readJsonRequest(c.req.raw);
  if (!body.ok) return jsonResponse({ ok: false, error: body.error }, 400);
  const parsed = parse(body.body);
  if (isParseFailure(parsed)) {
    return jsonResponse({ ok: false, error: parsed.error }, parsed.status ?? 400);
  }
  const result = await handler(parsed);
  const responseStatus = typeof status === "function"
    ? status(result)
    : result.ok ? status : (result.status ?? 400);
  return jsonResponse(result, responseStatus);
}
