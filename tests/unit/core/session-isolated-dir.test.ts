import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProcessIsolatedSessionDir } from "../../../src/core/session.js";

describe("getProcessIsolatedSessionDir", () => {
  it("appends _pid<PID> to the base path", () => {
    const result = getProcessIsolatedSessionDir("/home/u/ukg_session_sep");
    assert.match(result, /^\/home\/u\/ukg_session_sep_pid\d+$/);
    assert.ok(result.includes(String(process.pid)));
  });

  it("produces different paths for different pids", () => {
    const a = getProcessIsolatedSessionDir("/tmp/base", 1000);
    const b = getProcessIsolatedSessionDir("/tmp/base", 2000);
    assert.notStrictEqual(a, b);
    assert.strictEqual(a, "/tmp/base_pid1000");
    assert.strictEqual(b, "/tmp/base_pid2000");
  });
});
