import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitSessionEvent,
  readSessionEvents,
  getSessionsFilePath,
  getSessionsFilePathForDate,
} from "../../../src/tracker/session-events.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";

describe("sessions-* date rotation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sess-rot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes new events to a date-suffixed file", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Test 1" }, dir);
    const today = dateLocal();
    assert.ok(existsSync(join(dir, `sessions-${today}.jsonl`)));
  });

  it("reads from every dated snapshot file under the tracker dir", () => {
    writeFileSync(
      join(dir, "sessions-2026-01-01.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        pid: 1,
        workflowInstance: "Legacy 1",
      }) + "\n",
    );
    // Seed another old dated file.
    writeFileSync(
      join(dir, "sessions-2026-04-01.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-04-01T00:00:00.000Z",
        pid: 2,
        workflowInstance: "Apr 1",
      }) + "\n",
    );
    // Fresh emit lands in today's file.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Today 1" }, dir);

    const events = readSessionEvents(dir);
    const instances = events.map((e) => e.workflowInstance).sort();
    assert.deepEqual(instances, ["Apr 1", "Legacy 1", "Today 1"]);
  });

  it("getSessionsFilePathForDate returns the dated path", () => {
    assert.equal(
      getSessionsFilePathForDate("2026-05-07", dir),
      join(dir, "sessions-2026-05-07.jsonl"),
    );
  });

  it("getSessionsFilePath returns today's dated path", () => {
    const today = dateLocal();
    assert.equal(getSessionsFilePath(dir), join(dir, `sessions-${today}.jsonl`));
  });
});
