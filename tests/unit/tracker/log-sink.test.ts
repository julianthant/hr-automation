import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetTrackerLogSinkForTests,
  setTrackerLogSink,
  trackerWarn,
} from "../../../src/tracker/log-sink.js";

afterEach(() => {
  resetTrackerLogSinkForTests();
  vi.restoreAllMocks();
});

describe("tracker persistence log sink", () => {
  it("breaks recursive sink delivery by failing loud without bypassing the shared logger", () => {
    const delivered: string[] = [];
    setTrackerLogSink({
      warn(message) {
        delivered.push(message);
        trackerWarn("nested persistence warning");
      },
      error() {},
    });

    expect(() => trackerWarn("outer persistence warning"))
      .toThrow(/reentrant tracker log delivery.*nested persistence warning/i);

    expect(delivered).toEqual(["outer persistence warning"]);
  });
});
