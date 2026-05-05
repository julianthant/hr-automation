import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  jsonHeaders,
  readJsonBody,
  writeCorsPreflight,
  writeJson,
  writeSseHeaders,
} from "../../../src/tracker/dashboard/http.js";

function reqFrom(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as IncomingMessage;
}

function fakeResponse() {
  const state = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    ended: false,
  };
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      state.status = status;
      state.headers = headers ?? {};
      return this;
    },
    end(chunk?: unknown) {
      state.ended = true;
      if (chunk !== undefined) state.body += String(chunk);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

test("readJsonBody parses empty body as an empty object", async () => {
  const parsed = await readJsonBody(reqFrom(""));
  assert.deepEqual(parsed, { ok: true, body: {} });
});

test("readJsonBody returns Invalid JSON body for malformed JSON", async () => {
  const parsed = await readJsonBody(reqFrom("{bad"));
  assert.deepEqual(parsed, { ok: false, error: "Invalid JSON body" });
});

test("readJsonBody enforces maxBytes", async () => {
  const parsed = await readJsonBody(reqFrom(JSON.stringify({ value: "abcdef" })), 8);
  assert.deepEqual(parsed, { ok: false, error: "Request body too large" });
});

test("writeJson uses the dashboard JSON/CORS response shape", () => {
  const { res, state } = fakeResponse();
  writeJson(res, 202, { ok: true });
  assert.equal(state.status, 202);
  assert.equal(state.headers["Content-Type"], "application/json");
  assert.equal(state.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(state.body, "{\"ok\":true}");
});

test("writeCorsPreflight preserves current preflight headers", () => {
  const { res, state } = fakeResponse();
  writeCorsPreflight(res);
  assert.equal(state.status, 204);
  assert.equal(state.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
  assert.equal(state.headers["Access-Control-Allow-Headers"], "Content-Type");
  assert.equal(state.ended, true);
});

test("writeSseHeaders preserves event-stream headers", () => {
  const { res, state } = fakeResponse();
  writeSseHeaders(res);
  assert.equal(state.status, 200);
  assert.equal(state.headers["Content-Type"], "text/event-stream");
  assert.equal(state.headers["Cache-Control"], "no-cache");
  assert.equal(state.headers.Connection, "keep-alive");
  assert.equal(state.headers["Access-Control-Allow-Origin"], "*");
});

test("jsonHeaders can include full CORS method/header metadata", () => {
  assert.deepEqual(jsonHeaders({ fullCors: true }), {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
});
