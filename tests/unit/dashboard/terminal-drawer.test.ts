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

test("TerminalDrawer card container has bottom padding so the Stop button is not flush at the viewport bottom (E2E-104)", () => {
  const source = readFileSync(
    join(process.cwd(), "src/dashboard/components/terminal-drawer/TerminalDrawer.tsx"),
    "utf-8",
  );

  // The card-strip container must carry pb-5 (20px) rather than the symmetric
  // py-3 (12px) so the Stop pill and elapsed timer sit clear of the viewport
  // bottom edge. Guard that the asymmetric padding is present and the old
  // symmetric py-3 is NOT used for that element.
  assert.equal(source.includes("pb-5"), true, "card strip needs pb-5 bottom padding (E2E-104)");
  // py-3 would re-introduce flush bottom — it must not appear alongside the card strip.
  // We check the strip line itself rather than the whole file because py-3 could
  // legitimately appear in other places; the fix is specifically pt-3 pb-5.
  assert.equal(source.includes("px-3.5 pt-3 pb-5"), true, "card strip should use pt-3 pb-5 not py-3");
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
