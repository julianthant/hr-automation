import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";

test("TerminalDrawer renders workflow sessions without the daemon worker strip", () => {
  const source = readFileSync(
    join(process.cwd(), "src/dashboard/components/terminal-drawer/TerminalDrawer.tsx"),
    "utf-8",
  );

  assert.equal(source.includes("DaemonGroups"), false);
  assert.equal(source.includes("useDaemons"), false);
  assert.equal(source.includes('noun="workers"'), false);
  assert.equal(source.includes("No daemon workers"), false);
});
