import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";

import { createDashboardHonoApp, createPublicCaptureHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import {
  createDashboardAccessPolicy,
  OPERATOR_TOKEN_HEADER,
  REMOTE_ADDRESS_HEADER,
  resolveDashboardBindHost,
} from "../../../src/tracker/dashboard/hono/security.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDeps() {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-security-"));
  dirs.push(dir);
  const accessPolicy = createDashboardAccessPolicy({
    port: 3838,
    bindHost: "127.0.0.1",
    operatorToken: "test-operator-token",
  });
  return { dir, stateDb: openStateDb(dir), accessPolicy };
}

describe("dashboard access boundary", () => {
  test("issues the operator token only to an approved local Host and Origin", async () => {
    const app = createDashboardHonoApp(makeDeps());
    const response = await app.request("http://localhost:3838/api/operator/session", {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      token: "test-operator-token",
      header: OPERATOR_TOKEN_HEADER,
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("rejects hostile Host and Origin values before route handling", async () => {
    const app = createDashboardHonoApp(makeDeps());
    const badHost = await app.request("http://evil.example/api/workflow-definitions");
    assert.equal(badHost.status, 403);

    const badOrigin = await app.request("http://localhost:3838/api/workflow-definitions", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(badOrigin.status, 403);
  });

  test("requires the per-process token for every mutation method", async () => {
    const app = createDashboardHonoApp(makeDeps());
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const missing = await app.request("http://localhost:3838/api/not-a-real-route", { method });
      assert.equal(missing.status, 401, method);

      const authenticated = await app.request("http://localhost:3838/api/not-a-real-route", {
        method,
        headers: { [OPERATOR_TOKEN_HEADER]: "test-operator-token" },
      });
      assert.equal(authenticated.status, 404, method);
    }
  });

  test("returns origin-specific preflight headers and never wildcard CORS", async () => {
    const app = createDashboardHonoApp(makeDeps());
    const response = await app.request("http://localhost:3838/api/enqueue", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /x-hr-auto-operator-token/i);
    assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
  });

  test("rejects malformed workflow, date, and path components at the boundary", async () => {
    const app = createDashboardHonoApp(makeDeps());
    assert.equal((await app.request("http://localhost:3838/api/entries?workflow=%5Bobject%20Object%5D")).status, 400);
    assert.equal((await app.request("http://localhost:3838/api/entries?date=2026-02-30")).status, 400);
    assert.equal((await app.request("http://localhost:3838/api/files/%252e%252e/original")).status, 404);
    assert.equal((await app.request("http://localhost:3838/api/files/bad%5cname/original")).status, 400);
  });

  test("LAN reads require explicit Basic authentication before token bootstrap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-security-lan-"));
    dirs.push(dir);
    const accessPolicy = createDashboardAccessPolicy({
      port: 3838,
      bindHost: "0.0.0.0",
      operatorToken: "ephemeral-token",
      lanPassword: "a-strong-lan-password",
      extraOrigins: ["http://192.168.1.50:3838"],
    });
    const app = createDashboardHonoApp({ dir, stateDb: openStateDb(dir), accessPolicy });
    const baseHeaders = {
      Host: "192.168.1.50:3838",
      Origin: "http://192.168.1.50:3838",
      [REMOTE_ADDRESS_HEADER]: "192.168.1.50",
    };
    const denied = await app.request("http://192.168.1.50:3838/api/operator/session", {
      headers: baseHeaders,
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /Basic/);

    const accepted = await app.request("http://192.168.1.50:3838/api/operator/session", {
      headers: {
        ...baseHeaders,
        Authorization: `Basic ${Buffer.from("operator:a-strong-lan-password").toString("base64")}`,
      },
    });
    assert.equal(accepted.status, 200);
  });
});

describe("public phone Capture boundary", () => {
  test("exposes token-scoped phone routes but not dashboard or operator Capture routes", async () => {
    const previous = process.env.CAPTURE_PUBLIC_URL;
    process.env.CAPTURE_PUBLIC_URL = "https://capture.example.test";
    try {
      const deps = makeDeps();
      const app = createPublicCaptureHonoApp(deps);
      const headers = { Origin: "https://capture.example.test" };

      assert.equal((await app.request("/api/workflow-definitions", { headers })).status, 404);
      assert.equal((await app.request("/api/capture/start", { method: "POST", headers })).status, 404);
      assert.equal((await app.request("/api/capture/sessions", { headers })).status, 404);
      assert.equal((await app.request("/api/capture/manifest/not-a-token", { headers })).status, 404);
      assert.equal(
        (await app.request("/api/capture/manifest/not-a-token", {
          headers: { Origin: "https://evil.example" },
        })).status,
        403,
      );
    } finally {
      if (previous === undefined) delete process.env.CAPTURE_PUBLIC_URL;
      else process.env.CAPTURE_PUBLIC_URL = previous;
    }
  });
});

test("non-loopback dashboard binding requires an explicit LAN opt-in", () => {
  assert.equal(resolveDashboardBindHost(undefined, false), "127.0.0.1");
  assert.throws(() => resolveDashboardBindHost("0.0.0.0", false), /Refusing to bind dashboard/);
  assert.equal(resolveDashboardBindHost("0.0.0.0", true), "0.0.0.0");
  assert.throws(
    () => createDashboardAccessPolicy({ port: 3838, bindHost: "0.0.0.0" }),
    /LAN_PASSWORD/,
  );
});
