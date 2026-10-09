import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTailState, tailIncremental } from "../../../src/tracker/tail-incremental.js";

function withTempFile(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tail-incremental-"));
  try {
    fn(join(dir, "events.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("tailIncremental", () => {
  it("carries an incomplete trailing line forward", () => {
    withTempFile((path) => {
      const state = makeTailState();
      appendFileSync(path, "line1\nline2\npartial");

      assert.deepEqual(tailIncremental(path, state), ["line1", "line2"]);
      assert.equal(state.utf8Pending, "partial");

      appendFileSync(path, "rest\nline3\n");

      assert.deepEqual(tailIncremental(path, state), ["partialrest", "line3"]);
      assert.equal(state.utf8Pending, "");
    });
  });

  it("returns no lines when the file is unchanged", () => {
    withTempFile((path) => {
      const state = makeTailState();
      writeFileSync(path, "line1\n");

      assert.deepEqual(tailIncremental(path, state), ["line1"]);
      assert.deepEqual(tailIncremental(path, state), []);
    });
  });

  it("resets state and returns no lines when the file shrinks", () => {
    withTempFile((path) => {
      const state = makeTailState();
      writeFileSync(path, "line1\nline2\n");
      assert.deepEqual(tailIncremental(path, state), ["line1", "line2"]);

      writeFileSync(path, "new\n");

      assert.deepEqual(tailIncremental(path, state), []);
      assert.deepEqual(state, makeTailState());
    });
  });

  it("returns no lines when the file is missing", () => {
    const state = makeTailState();
    assert.deepEqual(tailIncremental("/tmp/does-not-exist-tail-incremental", state), []);
    assert.deepEqual(state, makeTailState());
  });
});
