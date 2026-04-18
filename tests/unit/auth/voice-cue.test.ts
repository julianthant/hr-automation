import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCueDuo } from "../../../src/auth/voice-cue.js";

// We never invoke the real `say` binary from tests. Instead we pass an
// injected `execFn` that records invocations in an array. The factory's
// cooldown + env + platform checks are fully covered without touching
// child_process or the OS.

function makeRecorder(): {
  calls: string[];
  execFn: (cmd: string) => void;
} {
  const calls: string[] = [];
  return { calls, execFn: (cmd: string) => calls.push(cmd) };
}

describe("createCueDuo", () => {
  describe("env-var gating", () => {
    it("no-ops when HR_AUTOMATION_VOICE_CUES is unset", async () => {
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: undefined,
      });
      await cue("UCPath");
      assert.equal(calls.length, 0);
    });

    it("no-ops when HR_AUTOMATION_VOICE_CUES is '0'", async () => {
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "0",
      });
      await cue("UCPath");
      assert.equal(calls.length, 0);
    });

    it("fires when HR_AUTOMATION_VOICE_CUES is '1'", async () => {
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "1",
      });
      await cue("UCPath");
      assert.equal(calls.length, 1);
      assert.match(calls[0], /^say "Duo for UCPath"$/);
    });
  });

  describe("platform gating", () => {
    it("no-ops on non-darwin platforms even when flag is '1'", async () => {
      const platforms: NodeJS.Platform[] = ["linux", "win32"];
      for (const platform of platforms) {
        const { calls, execFn } = makeRecorder();
        const cue = createCueDuo({ execFn, platform, envFlagValue: "1" });
        await cue("UCPath");
        assert.equal(calls.length, 0, `expected no cue on ${platform}`);
      }
    });
  });

  describe("cooldown", () => {
    it("suppresses repeated cues for the same systemId within 30s", async () => {
      let now = 1_000_000;
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "1",
        now: () => now,
      });
      await cue("UCPath");
      await cue("UCPath"); // t = 0 (same)
      now += 5_000;
      await cue("UCPath"); // t = 5s
      now += 20_000;
      await cue("UCPath"); // t = 25s (still inside cooldown)
      assert.equal(calls.length, 1, "only the first cue should have fired");
    });

    it("fires again after the 30s cooldown expires", async () => {
      let now = 1_000_000;
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "1",
        now: () => now,
      });
      await cue("UCPath");
      now += 30_001; // crosses the 30s boundary
      await cue("UCPath");
      assert.equal(calls.length, 2);
    });

    it("cooldown is per-systemId (cross-system cues are independent)", async () => {
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "1",
        now: () => 1_000_000,
      });
      await cue("UCPath");
      await cue("CRM");
      await cue("Kuali");
      assert.equal(calls.length, 3);
      assert.match(calls[0], /UCPath/);
      assert.match(calls[1], /CRM/);
      assert.match(calls[2], /Kuali/);
    });
  });

  describe("safety", () => {
    it("never throws when execFn throws synchronously", async () => {
      const cue = createCueDuo({
        execFn: () => {
          throw new Error("exec spawn failed");
        },
        platform: "darwin",
        envFlagValue: "1",
      });
      await assert.doesNotReject(cue("UCPath"));
    });

    it("sanitizes shell metacharacters out of the systemId", async () => {
      const { calls, execFn } = makeRecorder();
      const cue = createCueDuo({
        execFn,
        platform: "darwin",
        envFlagValue: "1",
      });
      await cue('UCPath"; rm -rf / #');
      assert.equal(calls.length, 1);
      // The quote + semicolon + slash + hash are all stripped; only alnum,
      // space, hyphen, underscore survive. The slash becomes a stripped
      // empty slot, leaving two spaces where "/ " used to be — harmless.
      assert.equal(calls[0], 'say "Duo for UCPath rm -rf  "');
      // Most importantly: no injected shell metacharacters survived inside
      // the quoted systemId portion.
      const m = calls[0].match(/^say "Duo for ([^"]*)"$/);
      assert.ok(m, "command didn't match expected shape");
      assert.doesNotMatch(m[1], /[";/#]/);
    });
  });
});
