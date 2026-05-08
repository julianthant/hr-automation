/**
 * Regression test: delegated-runId log routing via /events/hub (logs topic).
 *
 * When an OCR parent run spawns a child active-check run, the child has its
 * own runId and its own workflow name. The dashboard must:
 *
 *   1. Subscribe via /events/hub?subs=[{topic:"logs", params:{workflow:"active-check",id,runId}}]
 *      and receive ONLY the child's logs (from `active-check-<date>-logs.jsonl`).
 *   2. NOT receive logs from the parent OCR run or any other workflow.
 *
 * This test spins up the real Hono app against a temp directory, writes
 * both parent and child log files, and asserts the SSE response contains
 * exactly the child's log entries.
 */

import { afterEach, beforeEach, test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

const TEST_DATE = "2026-05-06";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delegated-runid-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({
    dir,
    stateDb: openStateDb(dir),
    workflow: "oath-upload",
    projectionReady: false,
  });
}

function appendTrackerEntry(workflow: string, entry: Partial<TrackerEntry>): void {
  const full: TrackerEntry = {
    workflow,
    timestamp: `${TEST_DATE}T10:00:00.000Z`,
    id: "unknown",
    runId: "unknown#1",
    status: "running",
    data: {},
    ...entry,
  };
  appendFileSync(join(dir, `${workflow}-${TEST_DATE}.jsonl`), `${JSON.stringify(full)}\n`);
}

function appendLog(
  workflow: string,
  entry: Record<string, unknown>,
): void {
  appendFileSync(
    join(dir, `${workflow}-${TEST_DATE}-logs.jsonl`),
    `${JSON.stringify(entry)}\n`,
  );
}

/** Build a hub request path for a single logs subscription. */
function logsHubPath(workflow: string, id: string, runId: string, date: string): string {
  const subs = encodeURIComponent(
    JSON.stringify([{ id: "s1", topic: "logs", params: { workflow, id, runId, date } }]),
  );
  return `/events/hub?subs=${subs}`;
}

async function readFirstSseMessage(response: Response, timeoutMs = 750): Promise<unknown[]> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, timeoutMs);

  try {
    while (!timedOut) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const splitAt = buffered.indexOf("\n\n");
      if (splitAt >= 0) {
        const block = buffered.slice(0, splitAt);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          clearTimeout(timer);
          await reader.cancel();
          // Unwrap the hub envelope: { sub, data } → data (which is the logs array)
          const envelope = JSON.parse(dataLine.slice("data: ".length)) as { sub: string; data: unknown };
          return envelope.data as unknown[];
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* already cancelled */ }
  }
  return [];
}

describe("/events/logs delegated-runId routing", () => {
  test("returns child active-check logs when queried by child workflow + runId", async () => {
    const parentRunId = "oath-upload-main#1";
    const childId = "99999999";
    const childRunId = "active-check-child#1";

    // Parent OCR run log — must NOT appear in the child query.
    appendLog("oath-upload", {
      workflow: "oath-upload",
      itemId: "prep-a3f1",
      runId: parentRunId,
      level: "step",
      message: "parent: uploading PDF",
      ts: `${TEST_DATE}T10:00:01.000Z`,
    });

    // Child active-check run logs.
    appendLog("active-check", {
      workflow: "active-check",
      itemId: childId,
      runId: childRunId,
      level: "step",
      message: "child: checking employee active status",
      ts: `${TEST_DATE}T10:00:02.000Z`,
    });
    appendLog("active-check", {
      workflow: "active-check",
      itemId: childId,
      runId: childRunId,
      level: "success",
      message: "child: employee is active",
      ts: `${TEST_DATE}T10:00:03.000Z`,
    });

    // A different child with a different itemId — must NOT appear.
    appendLog("active-check", {
      workflow: "active-check",
      itemId: "88888888",
      runId: "active-check-sibling#1",
      level: "step",
      message: "sibling: checking employee",
      ts: `${TEST_DATE}T10:00:02.500Z`,
    });

    const response = await app().request(logsHubPath("active-check", childId, childRunId, TEST_DATE));
    const messages = await readFirstSseMessage(response);

    // Must contain exactly the child's two log entries.
    assert.equal(messages.length, 2, `expected 2 child log entries, got ${messages.length}`);

    const texts = (messages as Array<{ message: string }>).map((m) => m.message);
    assert.ok(
      texts.every((t) => t.startsWith("child:")),
      `all messages must be child entries, got: ${JSON.stringify(texts)}`,
    );
    assert.ok(
      !texts.some((t) => t.startsWith("parent:")),
      "parent log entry must not appear in child query",
    );
    assert.ok(
      !texts.some((t) => t.startsWith("sibling:")),
      "sibling active-check log must not appear when filtering by childId",
    );
  });

  test("cross-workflow: querying oath-upload workflow does NOT return active-check logs", async () => {
    const childId = "99999999";
    const childRunId = "active-check-child#1";

    // Child active-check log.
    appendLog("active-check", {
      workflow: "active-check",
      itemId: childId,
      runId: childRunId,
      level: "step",
      message: "child: doing active check",
      ts: `${TEST_DATE}T10:00:02.000Z`,
    });

    // Query using the WRONG workflow (topbar workflow instead of entry.workflow).
    // This simulates the bug that LogPanel.105 prevents: if the frontend used
    // `topbarWorkflow` instead of `entry.workflow`, the route would read from
    // the wrong log file and return an empty array.
    const response = await app().request(logsHubPath("oath-upload", childId, childRunId, TEST_DATE));
    const messages = await readFirstSseMessage(response);

    // oath-upload-<date>-logs.jsonl has no entries for this itemId.
    assert.equal(
      messages.length,
      0,
      "querying the wrong (topbar) workflow must return empty — confirming that workflow param is the file discriminator",
    );
  });

  test("delegated runId is isolated from parent runId in the same workflow file", async () => {
    // Both parent and child writes happen to DIFFERENT workflow log files,
    // but this test verifies the runId filter works when both share the same
    // workflow (edge case: same-workflow parent-child delegation).
    const parentItemId = "parent-item";
    const parentRunId = "parent-item#1";
    const childItemId = "child-item";
    const childRunId = "child-item#1";

    appendLog("active-check", {
      workflow: "active-check",
      itemId: parentItemId,
      runId: parentRunId,
      level: "step",
      message: "parent active-check log",
      ts: `${TEST_DATE}T10:00:01.000Z`,
    });
    appendLog("active-check", {
      workflow: "active-check",
      itemId: childItemId,
      runId: childRunId,
      level: "step",
      message: "child active-check log",
      ts: `${TEST_DATE}T10:00:02.000Z`,
    });

    // Query specifically for the child item.
    const response = await app().request(logsHubPath("active-check", childItemId, childRunId, TEST_DATE));
    const messages = await readFirstSseMessage(response);

    assert.equal(messages.length, 1);
    assert.equal(
      (messages[0] as { message: string }).message,
      "child active-check log",
      "runId+itemId filter must isolate child from parent within same workflow file",
    );
  });
});
