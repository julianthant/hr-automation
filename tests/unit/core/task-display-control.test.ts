import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDisplay,
  type TaskRole,
} from "../../../src/core/task-display.js";
import {
  CONTROL_ACTIONS,
  describeControlAction,
} from "../../../src/core/task-control.js";

describe("task display", () => {
  it("keeps workflow name stable and uses task role for delegation", () => {
    assert.deepEqual(
      buildTaskDisplay({
        workflow: "eid-lookup",
        subject: "EID Lookup Zaw, Hein Thant",
        role: "child",
        originWorkflow: "ocr",
        parentSubject: "OCR oath-roster.pdf",
      }),
      {
        workflow: "eid-lookup",
        subject: "EID Lookup Zaw, Hein Thant",
        role: "child" satisfies TaskRole,
        originWorkflow: "ocr",
        parentSubject: "OCR oath-roster.pdf",
        queuePlacement: "subqueue",
      },
    );
  });

  it("keeps direct launches in the main queue", () => {
    assert.equal(
      buildTaskDisplay({
        workflow: "eid-lookup",
        subject: "EID Lookup Zaw, Hein Thant",
        role: "root",
      }).queuePlacement,
      "main",
    );
  });
});

describe("task control vocabulary", () => {
  it("defines the exact operator controls used by later SQLite phases", () => {
    assert.deepEqual(CONTROL_ACTIONS, [
      "cancel-queued",
      "cancel-current",
      "drain-worker",
      "stop-worker",
      "kill-browser",
      "force-kill-worker",
    ]);
  });

  it("describes cancel queued without browser disruption", () => {
    assert.equal(describeControlAction("cancel-queued").browserDisruption, false);
  });
});
