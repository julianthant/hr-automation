import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("append-only tracker deletion architecture", () => {
  const source = readFileSync(join(process.cwd(), "src/control/ops/delete.ts"), "utf8");

  it("never rewrites source JSONL during an operator delete", () => {
    expect(source).not.toContain("rewriteJsonlFile");
    expect(source).not.toMatch(/writeFileSync|truncateSync|unlinkSync/);
  });

  it("never hard-deletes terminal execution or audit history", () => {
    for (const table of ["tasks", "task_attempts", "task_dependencies", "run_events", "logs", "runs", "files"]) {
      expect(source.toLowerCase()).not.toContain(`delete from ${table}`);
    }
  });
});
