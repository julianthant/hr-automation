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

test("WorkflowBox asks before stopping the last daemon with in-flight work", () => {
  const workflowBox = readFileSync(
    join(process.cwd(), "src/dashboard/components/terminal-drawer/WorkflowBox.tsx"),
    "utf-8",
  );
  const terminalDrawer = readFileSync(
    join(process.cwd(), "src/dashboard/components/terminal-drawer/TerminalDrawer.tsx"),
    "utf-8",
  );

  assert.equal(workflowBox.includes("useConfirm"), true);
  assert.equal(workflowBox.includes("itemInFlight && !reassignable"), true);
  assert.equal(workflowBox.includes('confirmLabel: "Stop and fail item"'), true);
  assert.equal(workflowBox.includes("confirmDialog"), true);
  assert.equal(terminalDrawer.includes("reassignable={"), true);
});
