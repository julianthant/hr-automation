import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDashboardServer } from "../../../../src/tracker/dashboard/server.js";
import {
  createDashboardHonoApp,
  createPublicCaptureHonoApp,
} from "../../../../src/tracker/dashboard/hono/app.js";
import { dateLocal, emitTrackerRow } from "../../../../src/tracker/jsonl.js";
import { operatorSettingsFile, rowFilePath } from "../../../../src/tracker/paths.js";
import { closeStateDbForTests, openStateDb } from "../../../../src/tracker/state/db.js";

let root: string;
let trackerDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "settings-fault-route-"));
  trackerDir = join(root, ".tracker");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(operatorSettingsFile(root), "{ corrupt", "utf8");
});

afterEach(() => {
  closeStateDbForTests(trackerDir);
  rmSync(root, { recursive: true, force: true });
});

describe("configuration fault boundary", () => {
  test("GET settings exposes the fault without presenting default settings as valid", async () => {
    const app = createDashboardHonoApp({
      dir: trackerDir,
      stateDb: openStateDb(trackerDir),
      repoRoot: root,
    });
    const response = await app.request("/api/settings");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      settings: null,
      configuration: { state: "fault", backupAvailable: false },
    });
  });

  test("workflow mutations are blocked while repair and safety controls remain available", async () => {
    const app = createDashboardHonoApp({
      dir: trackerDir,
      stateDb: openStateDb(trackerDir),
      repoRoot: root,
    });
    const enqueue = await app.request("/api/enqueue", { method: "POST" });
    expect(enqueue.status).toBe(503);
    expect(await enqueue.json()).toMatchObject({ configurationFault: true });

    const dismiss = await app.request("/api/eid-approval/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "separations",
        id: "person-1",
        runId: "run-1",
        date: "2026-07-16",
      }),
    });
    expect(dismiss.status).not.toBe(503);

    const reset = await app.request("/api/settings", { method: "DELETE" });
    expect(reset.status).toBe(200);
  });

  test("phone Capture blocks finalize but permits pre-finalization photo operations", async () => {
    const app = createPublicCaptureHonoApp({
      dir: trackerDir,
      stateDb: openStateDb(trackerDir),
      repoRoot: root,
    });
    const finalize = await app.request("/api/capture/finalize", { method: "POST" });
    expect(finalize.status).toBe(503);
    const upload = await app.request("/api/capture/upload", { method: "POST" });
    expect(upload.status).not.toBe(503);
  });

  test("dashboard startup leaves stuck workflow rows untouched while settings are corrupt", async () => {
    emitTrackerRow({
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: "session-fault",
      runId: "run-fault",
      status: "running",
      step: "processing",
      data: { archetype: "preview" },
    }, trackerDir);

    const server = createDashboardServer({
      port: 0,
      dir: trackerDir,
      uploadPort: null,
      repoRoot: root,
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const rows = readFileSync(rowFilePath("ocr", dateLocal(), trackerDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string });
    expect(rows.at(-1)?.status).toBe("running");
  });
});
