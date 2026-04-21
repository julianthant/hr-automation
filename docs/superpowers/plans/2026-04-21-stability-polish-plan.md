# Stability Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land fixes for today's separations/onboarding failures + dashboard polish + CLI ergonomics across 5 coherent phases on master.

**Architecture:** Five phases (A–E) landing in order. Phase A clears the working tree (gemini's uncommitted diffs). Phase B is dashboard UI (low risk). Phase C fixes separations (biggest behavioral change). Phase D fixes onboarding + adds new CLI. Phase E cleans observability. Each phase is independent; each task within a phase is one commit.

**Tech Stack:** TypeScript, Node 24, Playwright, Vitest (Node test runner), React 19 + Vite 8 + Tailwind v4 + Radix (dashboard), PeopleSoft + Kuali Build + UKG + I9 Complete + New Kronos (automated systems).

**Reference spec:** `docs/superpowers/specs/2026-04-21-stability-polish-design.md` — read before starting a phase.

---

## File Structure

### Created
- `src/core/session.ts` → add export `getProcessIsolatedSessionDir` (C.1)
- `src/systems/i9/navigate.ts` → add export `closeAllKendoWindows` (if file doesn't exist, create)
- `docs/step-cache.md` → explainer doc (E.4)

### Modified
- `src/utils/pii.ts` → already modified by gemini (stays)
- `src/systems/new-kronos/navigate.ts` → already modified by gemini (stays)
- `src/tracker/session-events.ts` → already modified by gemini (stays); also E.1 timestamp audit
- `src/tracker/dashboard.ts` → already modified by gemini (stays); also E.1/E.2 crash placeholder + timestamp normalization
- `src/dashboard/components/LogStream.tsx` → already modified by gemini (stays)
- `src/dashboard/components/LogPanel.tsx` → remove FailureDrillDown mount (B.1)
- `src/dashboard/components/StepPipeline.tsx` → hover popover + graceful timer (B.2, B.3)
- `src/dashboard/components/ScreenshotsPanel.tsx` + `ScreenshotCard.tsx` → URL encoding audit (B.5)
- `src/dashboard/components/SessionPanel.tsx` → crashed-launch placeholder (E.2)
- `src/workflows/separations/schema.ts` → "Last day worked" label (B.4)
- `src/workflows/separations/workflow.ts` → sessionDir isolation, job-summary rethrow, step-cache, txn # assertion (C.1, C.2, C.5, C.6)
- `src/systems/ucpath/job-summary.ts` → Work Location retry (C.3)
- `src/systems/ucpath/transaction.ts` → Save enabled wait (C.4 + D.2)
- `src/systems/i9/search.ts` → closeAllKendoWindows on return (D.1)
- `src/systems/i9/create.ts` → closeAllKendoWindows + retry on create click (D.1)
- `src/workflows/onboarding/enter.ts` → tab-walk audit (D.2)
- `src/workflows/onboarding/index.ts` → `runOnboardingPositional` export (D.3)
- `src/cli.ts` → new `onboarding` command (D.3)
- `package.json` → new `onboarding` / `onboarding:dry` scripts (D.3)
- `.gitignore` → add `image.png`, `notes.md` (A.2)

### Deleted
- `src/dashboard/components/FailureDrillDown.tsx` (B.1)

### Tests (created/modified)
- `tests/unit/utils/pii.test.ts` → pass-through assertions (A.1)
- `tests/unit/dashboard/step-pipeline.partial-timer.test.ts` → new (B.3)
- `tests/unit/systems/new-kronos/timecard-date.test.ts` → sparse date carry-forward if missing (A.1)
- `tests/unit/workflows/separations/job-summary-propagation.test.ts` → new (C.2)
- `tests/unit/workflows/separations/step-cache-kuali-extraction.test.ts` → new (C.5)
- `tests/unit/core/session-isolated-dir.test.ts` → new (C.1)
- `tests/unit/systems/i9/close-kendo-windows.test.ts` → new (D.1)
- `tests/unit/systems/ucpath/save-enabled-wait.test.ts` → new (C.4 / D.2)
- `tests/unit/tracker/timestamp-normalization.test.ts` → new (E.1)

---

## Phase A — Triage gemini's working-tree diffs

Working tree currently has 5 uncommitted files from a previous session. Decide and commit.

### Task A.1: Update PII test assertions for pass-through behavior

**Files:**
- Modify: `tests/unit/utils/pii.test.ts`

- [ ] **Step 1: Read existing test file**

Run: `cat tests/unit/utils/pii.test.ts`

Look at current assertions — they assume masking (e.g. `maskSsn("123-45-6789")` returns `"***-**-6789"`).

- [ ] **Step 2: Update test to assert pass-through**

Replace each assertion block. For `maskSsn`:

```ts
test("maskSsn returns the SSN unchanged (redaction disabled)", () => {
  assert.strictEqual(maskSsn("123-45-6789"), "123-45-6789");
  assert.strictEqual(maskSsn("123456789"), "123456789");
  assert.strictEqual(maskSsn(""), "");
  assert.strictEqual(maskSsn(null), "");
  assert.strictEqual(maskSsn(undefined), "");
});
```

For `maskDob`:

```ts
test("maskDob returns the DOB unchanged", () => {
  assert.strictEqual(maskDob("05/11/2007"), "05/11/2007");
  assert.strictEqual(maskDob("2007-05-11"), "2007-05-11");
  assert.strictEqual(maskDob(""), "");
  assert.strictEqual(maskDob(null), "");
});
```

For `redactPii`:

```ts
test("redactPii returns the input unchanged", () => {
  const input = "SSN 123-45-6789 DOB 05/11/2007";
  assert.strictEqual(redactPii(input), input);
  assert.strictEqual(redactPii(""), "");
  assert.strictEqual(redactPii(null), "");
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test -- --test-name-pattern="pii"`

Expected: PASS for all three. If any pre-existing assertion survives that still expects masking, delete it.

- [ ] **Step 4: Commit (will be bundled in A.3)**

Do not commit yet — bundled with the rest of the gemini-diff commit in A.3.

### Task A.2: Gitignore image.png and notes.md

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read current .gitignore**

Run: `cat .gitignore | head -30`

- [ ] **Step 2: Append entries**

Append at the end of `.gitignore`:

```gitignore

# Scratch files (chat references, not meant to be committed)
/image.png
/notes.md
```

- [ ] **Step 3: Verify they're ignored**

Run: `git status --porcelain | grep -E "image\.png|notes\.md"`

Expected: no output (both files now ignored).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore scratch files (image.png, notes.md)"
```

### Task A.3: Commit the 5 gemini diffs + updated PII tests

**Files:**
- Already-modified (gemini): `src/utils/pii.ts`, `src/systems/new-kronos/navigate.ts`, `src/tracker/session-events.ts`, `src/tracker/dashboard.ts`, `src/dashboard/components/LogStream.tsx`
- Modified in A.1: `tests/unit/utils/pii.test.ts`

- [ ] **Step 1: Verify no other uncommitted changes**

Run: `git status`

Expected: only the 5 gemini diffs + the pii.test.ts change. If anything else is modified, stop and investigate.

- [ ] **Step 2: Run typecheck + full tests**

Run: `npm run typecheck:all && npm run test`

Expected: PASS. If new-kronos/navigate.ts has a unit test that breaks due to sparse-date carry-forward change, fix the test assertion to match new behavior.

- [ ] **Step 3: Commit**

```bash
git add src/utils/pii.ts src/systems/new-kronos/navigate.ts \
       src/tracker/session-events.ts src/tracker/dashboard.ts \
       src/dashboard/components/LogStream.tsx tests/unit/utils/pii.test.ts
git commit -m "$(cat <<'EOF'
chore: land pending diffs (PII pass-through, Kronos date alignment, session-events count, null-safe sort)

- pii.ts: redaction disabled (user request) — tests updated for pass-through
- new-kronos/navigate.ts: carry-forward lastSeenDate for sparse-date / dense-data row alignment
- session-events.ts: count-based generateInstanceName (Set-based broke when name appeared in both starts and ends)
- dashboard.ts + LogStream.tsx: null-safe localeCompare while E traces the missing-timestamp source

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify working tree is clean**

Run: `git status --porcelain`

Expected: empty output.

---

## Phase B — Dashboard UI polish

### Task B.1: Delete FailureDrillDown + remove mount

**Files:**
- Delete: `src/dashboard/components/FailureDrillDown.tsx`
- Modify: `src/dashboard/components/LogPanel.tsx`

- [ ] **Step 1: Read LogPanel.tsx around FailureDrillDown usage**

Run: `grep -n "FailureDrillDown" src/dashboard/components/LogPanel.tsx`

Note the import line (~7) and the mount block (~230–240).

- [ ] **Step 2: Remove import line**

In `src/dashboard/components/LogPanel.tsx`, delete the line:
```tsx
import { FailureDrillDown } from "./FailureDrillDown";
```

- [ ] **Step 3: Remove mount block**

Find the JSX block like:
```tsx
{entry.status === "failed" && (
  <FailureDrillDown entry={entry} workflow={workflow} />
)}
```

Delete it entirely.

- [ ] **Step 4: Delete the component file**

```bash
rm src/dashboard/components/FailureDrillDown.tsx
```

- [ ] **Step 5: Check for dangling references**

Run: `grep -r "FailureDrillDown" src/ tests/ 2>/dev/null`

Expected: no matches. If any remain, remove them (most likely test files — delete those too).

- [ ] **Step 6: Typecheck + build dashboard**

Run: `npm run typecheck && npm run build:dashboard`

Expected: PASS. If build fails with missing file error, remove the dangling reference.

- [ ] **Step 7: Commit**

```bash
git add -A src/dashboard/components/
git commit -m "feat(dashboard): remove FailureDrillDown — screenshots live in Screenshots tab only"
```

### Task B.2: AuthSuperChip — click-to-expand → hover popover

**Files:**
- Modify: `src/dashboard/components/StepPipeline.tsx`

- [ ] **Step 1: Verify Popover primitive exists**

Run: `head -40 src/dashboard/components/ui/popover.tsx`

Expected: Radix popover export (`Popover`, `PopoverTrigger`, `PopoverContent`).

- [ ] **Step 2: Add Popover + useRef imports to StepPipeline**

Near the top of `src/dashboard/components/StepPipeline.tsx`, add:

```tsx
import { useRef, useState } from "react";  // extend existing react import
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
```

(Or the relative path `./ui/popover` — match existing import style in the file. `useState` may already be imported; ensure `useRef` is added.)

- [ ] **Step 3: Rewrite AuthSuperChip component**

Replace the entire `AuthSuperChip` component (currently ~L128-229) with:

```tsx
interface AuthSuperChipProps {
  children: StepView[];
}

function AuthSuperChip({ children }: AuthSuperChipProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleOpen = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), 100);
  };
  const scheduleClose = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const groupStatus = authGroupStatus(children);

  const knownDurations = children.filter((c) => c.durationMs !== undefined);
  const totalDurationMs = knownDurations.length > 0
    ? knownDurations.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
    : undefined;
  const partial = knownDurations.length < children.length;
  const durationLabel = totalDurationMs !== undefined
    ? `${formatStepDuration(totalDurationMs)}${partial ? "+" : ""}`
    : "";

  const isCached = groupStatus === "cached";
  const isComplete = groupStatus === "completed";
  const isActive = groupStatus === "running";
  const isFailedStep = groupStatus === "failed";
  const isPending = groupStatus === "pending";

  const hoverTitle = buildAuthGroupTitle(children);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          title={hoverTitle}
          className="flex-1 min-w-[86px] flex flex-col justify-center items-start gap-1.5 cursor-default"
          style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}
        >
          {/* Label */}
          <span
            className={cn(
              "text-[11.5px] tracking-tight leading-none truncate w-full transition-colors",
              !isCached && isComplete && "text-[#4ade80] font-medium",
              !isCached && isActive && "text-primary font-semibold",
              !isCached && isFailedStep && "text-destructive font-semibold",
              !isCached && isPending && "text-muted-foreground/50 font-medium",
              isCached && "font-medium",
            )}
            style={isCached ? { color: "#3b82f6" } : undefined}
          >
            Authenticating ({children.length})
          </span>

          {/* Rail (unchanged) */}
          <div
            className="relative w-full h-[3px] rounded-full"
            style={isCached ? { backgroundColor: "#3b82f6", boxShadow: "0 0 0 3px rgba(59,130,246,0.15)" } : undefined}
          >
            {isPending ? (
              <div
                aria-hidden
                className="absolute inset-0 rounded-full opacity-70 overflow-hidden"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(to right, hsl(var(--border)) 0 4px, transparent 4px 8px)",
                }}
              />
            ) : (
              <div
                className={cn(
                  "absolute inset-0 rounded-full overflow-hidden transition-colors",
                  isComplete && "bg-[#4ade80]/80",
                  isActive && "bg-primary/25",
                  isFailedStep && "bg-destructive/80",
                )}
                style={authRailStyle(groupStatus)}
              />
            )}
            {isActive && (
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary animate-[pulse_1.6s_ease-in-out_infinite]"
              />
            )}
          </div>

          {/* Duration */}
          <span
            className={cn(
              "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
              !isCached && isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
              !isCached && isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
              !isCached && isActive && "text-primary/70",
              !isCached && isPending && "text-muted-foreground/35",
            )}
            aria-hidden={!durationLabel && !isPending}
          >
            {durationLabel || (isPending ? "—" : isActive ? "…" : "—")}
          </span>
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        className="w-auto p-2"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
      >
        <div className="flex flex-col gap-1.5 text-xs">
          {children.map((child) => {
            const systemId = child.name.startsWith("auth:") ? child.name.slice(5) : child.name;
            const statusGlyph =
              child.status === "completed" || child.status === "cached" ? "✓"
              : child.status === "failed" ? "✗"
              : child.status === "running" ? "…"
              : "–";
            const glyphColor =
              child.status === "completed" || child.status === "cached" ? "text-[#4ade80]"
              : child.status === "failed" ? "text-destructive"
              : child.status === "running" ? "text-primary"
              : "text-muted-foreground";
            return (
              <div key={child.name} className="flex items-center gap-3 min-w-[180px]">
                <span className={cn("w-3 text-center", glyphColor)}>{statusGlyph}</span>
                <span className="font-mono text-[11px]">{systemId}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
                  {child.durationMs !== undefined ? formatStepDuration(child.durationMs) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Remove expand state + toggle logic from StepPipeline**

In the `StepPipeline` function body, delete:
- `const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());` (~L253)
- The `toggleGroup` function (~L296-303)

Change the node render for auth-group from:
```tsx
<AuthSuperChip
  key={groupKey}
  children={node.children}
  expanded={isExpanded}
  onToggle={() => toggleGroup(groupKey)}
/>
```

To:
```tsx
<AuthSuperChip key={groupKey} children={node.children} />
```

Also delete the entire "Expanded auth-group children" block (~L451-548) — the `{nodes.filter(isAuthGroup).filter(...).map(...)}` block.

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build:dashboard`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/StepPipeline.tsx
git commit -m "feat(dashboard): auth chip hover popover replaces click-to-expand"
```

### Task B.3: Auth chip — graceful partial timer test

**Files:**
- Create: `tests/unit/dashboard/step-pipeline.partial-timer.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/dashboard/step-pipeline.partial-timer.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pure helper exposed from StepPipeline.tsx — we only test the aggregation logic.
// If the helper isn't yet exported, exporting it is part of Step 3.

import { computeAuthGroupDuration } from "../../../src/dashboard/components/StepPipeline";

describe("computeAuthGroupDuration", () => {
  it("returns undefined when no children have durations", () => {
    const children = [
      { name: "auth:kuali", status: "running" as const, durationMs: undefined },
      { name: "auth:ucpath", status: "pending" as const, durationMs: undefined },
    ];
    assert.strictEqual(computeAuthGroupDuration(children), undefined);
  });

  it("returns total with no suffix when every child has a duration", () => {
    const children = [
      { name: "auth:kuali", status: "completed" as const, durationMs: 1000 },
      { name: "auth:ucpath", status: "completed" as const, durationMs: 2000 },
    ];
    const result = computeAuthGroupDuration(children);
    assert.deepStrictEqual(result, { totalMs: 3000, partial: false });
  });

  it("returns partial total with suffix=true when some children have durations", () => {
    const children = [
      { name: "auth:kuali", status: "completed" as const, durationMs: 1500 },
      { name: "auth:ucpath", status: "running" as const, durationMs: undefined },
    ];
    const result = computeAuthGroupDuration(children);
    assert.deepStrictEqual(result, { totalMs: 1500, partial: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/dashboard/step-pipeline.partial-timer.test.ts`

Expected: FAIL with import error (no export `computeAuthGroupDuration`).

- [ ] **Step 3: Extract the helper from StepPipeline**

In `src/dashboard/components/StepPipeline.tsx`, just above the `AuthSuperChip` component, add:

```tsx
export function computeAuthGroupDuration(
  children: StepView[],
): { totalMs: number; partial: boolean } | undefined {
  const known = children.filter((c) => c.durationMs !== undefined);
  if (known.length === 0) return undefined;
  const totalMs = known.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  return { totalMs, partial: known.length < children.length };
}
```

Then in `AuthSuperChip`, replace the inline aggregation:
```tsx
const knownDurations = children.filter((c) => c.durationMs !== undefined);
const totalDurationMs = knownDurations.length > 0
  ? knownDurations.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
  : undefined;
const partial = knownDurations.length < children.length;
```
With:
```tsx
const aggregate = computeAuthGroupDuration(children);
const totalDurationMs = aggregate?.totalMs;
const partial = aggregate?.partial ?? false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/dashboard/step-pipeline.partial-timer.test.ts`

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/StepPipeline.tsx tests/unit/dashboard/step-pipeline.partial-timer.test.ts
git commit -m "feat(dashboard): auth chip timer shows partial total when some children still running"
```

### Task B.4: Fix "Last day worked" label

**Files:**
- Modify: `src/workflows/separations/schema.ts`

- [ ] **Step 1: Grep for the exact phrase**

Run: `grep -n "Last day worked" src/workflows/separations/schema.ts`

Expected: finds `Last day worked:` (with colon) in `buildTerminationComments`. Also check `buildDateChangeComments`.

- [ ] **Step 2: Make the edit**

In `src/workflows/separations/schema.ts`, line ~55 (`buildTerminationComments`):

```ts
// before
return `Termination EFF ${terminationEffDate}. Last day worked: ${lastDayWorked}. Kuali form #${docId}.`;
// after
return `Termination EFF ${terminationEffDate}. Last day worked ${lastDayWorked}. Kuali form #${docId}.`;
```

If `buildDateChangeComments` also uses the colon form, apply the same change.

- [ ] **Step 3: Update test if it pins the exact string**

Run: `grep -n "Last day worked" tests/`

If any test asserts the old string, update the assertion.

- [ ] **Step 4: Run tests**

Run: `npm run test -- tests/unit/workflows/separations/`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/separations/schema.ts tests/unit/workflows/separations/
git commit -m "fix(separations): drop colon from 'Last day worked' comment label"
```

### Task B.5: Audit ScreenshotsPanel URL encoding

**Files:**
- Modify (possibly): `src/dashboard/components/ScreenshotsPanel.tsx`, `src/dashboard/components/ScreenshotCard.tsx`

- [ ] **Step 1: Find URL construction sites**

Run: `grep -n "/screenshots/" src/dashboard/components/ScreenshotsPanel.tsx src/dashboard/components/ScreenshotCard.tsx src/dashboard/components/ScreenshotLightbox.tsx`

- [ ] **Step 2: Check each site uses encodeURIComponent on the filename**

For each match, confirm the URL is built like:
```tsx
const url = `/screenshots/${encodeURIComponent(filename)}`;
```

- [ ] **Step 3: Fix any raw-filename usages**

If you find:
```tsx
const url = `/screenshots/${filename}`;
```

Change to:
```tsx
const url = `/screenshots/${encodeURIComponent(filename)}`;
```

Filenames like `onboarding-user@domain.com-error-....png` contain `@` which most browsers handle but not all — encoding is consistent.

- [ ] **Step 4: Build dashboard + manual smoke**

Run: `npm run build:dashboard`

Start `npm run dashboard` in another terminal, open http://localhost:5173, navigate to a run with screenshots, verify thumbnails render.

- [ ] **Step 5: Commit (if changes made)**

```bash
git add src/dashboard/components/
git commit -m "fix(dashboard): encode screenshot filenames in URL (emails contain '@')"
```

If no changes were needed, skip commit and move to B.6.

### Task B.6: Phase B sanity — full test + typecheck

- [ ] **Step 1: Run full suite**

```bash
npm run typecheck:all && npm run test
```

Expected: PASS everything. If anything fails, investigate and fix before moving to Phase C.

---

## Phase C — Separations bugs

### Task C.1: Add `getProcessIsolatedSessionDir` helper

**Files:**
- Modify: `src/core/session.ts`
- Create: `tests/unit/core/session-isolated-dir.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/core/session-isolated-dir.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test**

Run: `npm run test -- tests/unit/core/session-isolated-dir.test.ts`

Expected: FAIL — export not defined.

- [ ] **Step 3: Implement the helper**

In `src/core/session.ts`, near the bottom (after existing exports), add:

```ts
/**
 * Return a sessionDir path isolated by process PID. Use this for persistent
 * Chrome profiles (launchPersistentContext) in workflows that may be run as
 * multiple parallel OS processes — each process gets its own directory so
 * Chromium's ProcessSingleton lock doesn't collide.
 *
 * @param basePath The non-isolated base (e.g. ~/ukg_session_sep)
 * @param pid Override for testing. Defaults to process.pid.
 */
export function getProcessIsolatedSessionDir(basePath: string, pid: number = process.pid): string {
  return `${basePath}_pid${pid}`;
}
```

- [ ] **Step 4: Run test again**

Run: `npm run test -- tests/unit/core/session-isolated-dir.test.ts`

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/unit/core/session-isolated-dir.test.ts
git commit -m "feat(core): getProcessIsolatedSessionDir helper for multi-process persistent profiles"
```

### Task C.2: Separations — per-process sessionDir + cleanup

**Files:**
- Modify: `src/workflows/separations/workflow.ts`

- [ ] **Step 1: Import the helper**

In `src/workflows/separations/workflow.ts`, add to the core imports:

```ts
import { getProcessIsolatedSessionDir } from "../../core/session.js";
```

Also add if not already present:
```ts
import { rmSync } from "node:fs";
```

- [ ] **Step 2: Parameterize sessionDir**

Find line ~151:
```ts
sessionDir: PATHS.ukgSessionSep,
```

Change to:
```ts
sessionDir: getProcessIsolatedSessionDir(PATHS.ukgSessionSep),
```

- [ ] **Step 3: Add cleanup in CLI adapters**

Find `runSeparation` and `runSeparationBatch` functions in the same file. Wrap the `runWorkflow` / `runWorkflowBatch` call in a try/finally:

```ts
export async function runSeparation(docId: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  if (opts.dryRun) {
    previewSeparationPipeline(docId);
    return;
  }
  const sessionDir = getProcessIsolatedSessionDir(PATHS.ukgSessionSep);
  try {
    await runWorkflow(separationsWorkflow, { docId });
  } finally {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}
```

Do the same for `runSeparationBatch`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Run separations tests**

Run: `npm run test -- tests/unit/workflows/separations/`

Expected: PASS. If a test mocks `PATHS.ukgSessionSep` and asserts exact equality, update the assertion to match `*_pid*` pattern.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/separations/workflow.ts
git commit -m "fix(separations): per-process UKG sessionDir — multiple npm run separation can coexist"
```

### Task C.3: Propagate Job Summary failure

**Files:**
- Modify: `src/workflows/separations/workflow.ts`
- Create: `tests/unit/workflows/separations/job-summary-propagation.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/workflows/separations/job-summary-propagation.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Imports the pure helper that will decide whether to rethrow.
// If the helper isn't yet extracted, Step 3 extracts it.
import { resolveJobSummaryResult } from "../../../../src/workflows/separations/workflow.js";

describe("resolveJobSummaryResult", () => {
  it("returns the value when fulfilled", () => {
    const result = resolveJobSummaryResult({
      status: "fulfilled",
      value: { departmentDescription: "XYZ", jobCode: "1234", jobDescription: "Analyst" },
    });
    assert.deepStrictEqual(result, {
      departmentDescription: "XYZ", jobCode: "1234", jobDescription: "Analyst",
    });
  });

  it("throws with contextual message when rejected", () => {
    assert.throws(
      () => resolveJobSummaryResult({
        status: "rejected",
        reason: new Error("Timeout 10000ms exceeded"),
      }),
      /UCPath Job Summary extraction failed: Timeout 10000ms exceeded/,
    );
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm run test -- tests/unit/workflows/separations/job-summary-propagation.test.ts`

Expected: FAIL — export not defined.

- [ ] **Step 3: Extract helper + use it in the handler**

In `src/workflows/separations/workflow.ts`, just above the `separationsWorkflow = defineWorkflow({...})` declaration, add:

```ts
import type { JobSummaryData } from "../../systems/ucpath/types.js";

export function resolveJobSummaryResult(
  result: PromiseSettledResult<JobSummaryData | undefined>,
): JobSummaryData | undefined {
  if (result.status === "fulfilled") return result.value;
  throw new Error(`UCPath Job Summary extraction failed: ${errorMessage(result.reason)}`);
}
```

Then in the handler, replace the current phase1 job-summary branch (~L297-301):

```ts
// before
if (phase1.jobSummary.status === "fulfilled") {
  jobSummaryData = phase1.jobSummary.value;
} else {
  log.error(`[UCPath Job Summary] Failed: ${errorMessage(phase1.jobSummary.reason)}`);
}
```

With:

```ts
// after
try {
  jobSummaryData = resolveJobSummaryResult(phase1.jobSummary);
} catch (e) {
  log.error(errorMessage(e));
  throw e;
}
```

- [ ] **Step 4: Run test**

Run: `npm run test -- tests/unit/workflows/separations/job-summary-propagation.test.ts`

Expected: PASS (2/2).

- [ ] **Step 5: Run full separations tests + typecheck**

Run: `npm run typecheck && npm run test -- tests/unit/workflows/separations/`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/separations/workflow.ts tests/unit/workflows/separations/job-summary-propagation.test.ts
git commit -m "fix(separations): propagate Job Summary failure instead of silent continue (was producing empty txn #)"
```

### Task C.4: Harden Work Location tab click

**Files:**
- Modify: `src/systems/ucpath/job-summary.ts`

- [ ] **Step 1: Read current extractWorkLocation**

Run: `grep -n "workLocationTab\|extractWorkLocation" src/systems/ucpath/job-summary.ts`

Find the click site (~L85).

- [ ] **Step 2: Add waitForPeopleSoftProcessing + retry**

Ensure the imports at the top include:
```ts
import { waitForPeopleSoftProcessing, getContentFrame } from "./navigate.js";
```

Replace the direct click with:

```ts
// Wait for any in-flight PS processing before the tab click, then retry once.
// Today's run on doc 3917 saw this click flake while same-day sibling docs
// succeeded — transient state, not a selector issue.
await waitForPeopleSoftProcessing(root as FrameLocator, 15_000).catch(() => {});

const clickOnce = async (): Promise<void> => {
  await jobSummary.workLocationTab(root).click({ timeout: 15_000 });
};

try {
  await clickOnce();
} catch (e) {
  log.warn(`[Job Summary] Work Location tab click flaked — retrying once: ${errorMessage(e)}`);
  await page.waitForTimeout(2000);
  await waitForPeopleSoftProcessing(root as FrameLocator, 15_000).catch(() => {});
  await clickOnce();
}
```

Adjust the `root` cast to match the actual parameter type (`Locator` vs `FrameLocator`) — if `getFormRoot` already returns the right shape, no cast needed.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: PASS. If type errors, adjust `root` handling.

- [ ] **Step 4: Run tests**

Run: `npm run test -- tests/unit/systems/ucpath/`

Expected: PASS. (Adding retry is behavior-level; if an existing test mocks click to always fail, it now fails twice before rethrowing — test still passes because the error still propagates.)

- [ ] **Step 5: Commit**

```bash
git add src/systems/ucpath/job-summary.ts
git commit -m "fix(ucpath): retry Work Location tab click once + wait for PeopleSoft processing"
```

### Task C.5: Save-and-Submit enabled wait

**Files:**
- Modify: `src/systems/ucpath/transaction.ts`
- Create: `tests/unit/systems/ucpath/save-enabled-wait.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/systems/ucpath/save-enabled-wait.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForSaveEnabled } from "../../../../src/systems/ucpath/transaction.js";

type FakeLocator = {
  isEnabled: () => Promise<boolean>;
  waitFor: () => Promise<void>;
};

describe("waitForSaveEnabled", () => {
  it("resolves immediately when the button is enabled on first poll", async () => {
    const locator: FakeLocator = {
      isEnabled: async () => true,
      waitFor: async () => {},
    };
    await waitForSaveEnabled(locator as never, { timeoutMs: 1000, pollMs: 50 });
  });

  it("throws with diagnostic message when still disabled after timeout", async () => {
    const locator: FakeLocator = {
      isEnabled: async () => false,
      waitFor: async () => {},
    };
    await assert.rejects(
      waitForSaveEnabled(locator as never, { timeoutMs: 150, pollMs: 50 }),
      /Save and Submit remained disabled/,
    );
  });

  it("resolves once the button becomes enabled mid-wait", async () => {
    let calls = 0;
    const locator: FakeLocator = {
      isEnabled: async () => ++calls >= 3,
      waitFor: async () => {},
    };
    await waitForSaveEnabled(locator as never, { timeoutMs: 1000, pollMs: 20 });
    assert.ok(calls >= 3);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm run test -- tests/unit/systems/ucpath/save-enabled-wait.test.ts`

Expected: FAIL — `waitForSaveEnabled` not exported.

- [ ] **Step 3: Implement helper + use it in clickSaveAndSubmit**

In `src/systems/ucpath/transaction.ts`, add the helper near the top of the file (or near `clickSaveAndSubmit`):

```ts
import type { Locator } from "playwright";

export async function waitForSaveEnabled(
  btn: Pick<Locator, "isEnabled" | "waitFor">,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 15_000, pollMs = 500 } = opts;
  await btn.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 10_000) } as never).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await btn.isEnabled().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    "Save and Submit remained disabled after 15 s — tab walk likely incomplete (visit all 4 Smart HR tabs + fill Initiator Comments + re-click Personal Data before save)",
  );
}
```

Then update `clickSaveAndSubmit` (~L508-532):

```ts
// before
await smartHR.saveAndSubmitButton(frame).click({ timeout: 10_000 });
// after
const btn = smartHR.saveAndSubmitButton(frame);
try {
  await waitForSaveEnabled(btn, { timeoutMs: 15_000 });
} catch (e) {
  await page.screenshot({ path: `.screenshots/save-disabled-${Date.now()}.png` }).catch(() => {});
  throw e;
}
await btn.click({ timeout: 10_000 });
```

- [ ] **Step 4: Run test**

Run: `npm run test -- tests/unit/systems/ucpath/save-enabled-wait.test.ts`

Expected: PASS (3/3).

- [ ] **Step 5: Full tests + typecheck**

Run: `npm run typecheck && npm run test -- tests/unit/systems/ucpath/`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/systems/ucpath/transaction.ts tests/unit/systems/ucpath/save-enabled-wait.test.ts
git commit -m "fix(ucpath): wait for Save and Submit button to be enabled before click + diagnostic screenshot"
```

### Task C.6: Step-cache for kuali-extraction

**Files:**
- Modify: `src/workflows/separations/workflow.ts`
- Create: `tests/unit/workflows/separations/step-cache-kuali-extraction.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/workflows/separations/step-cache-kuali-extraction.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepCacheSet, stepCacheGet } from "../../../../src/core/step-cache.js";

describe("separations step-cache for kuali-extraction", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sep-cache-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("round-trips separation data through the cache", async () => {
    const doc = "3917";
    const data = {
      employeeName: "Sutisna, Reyhan",
      eid: "10835489",
      separationDate: "04/20/2026",
      lastDayWorked: "04/20/2026",
      terminationType: "Vol",
    };

    await stepCacheSet("separations", doc, "kuali-extraction", data, { dir: tmpDir });
    const read = await stepCacheGet("separations", doc, "kuali-extraction", { dir: tmpDir });

    assert.deepStrictEqual(read, data);
  });

  it("returns undefined on cache miss", async () => {
    const read = await stepCacheGet("separations", "9999", "kuali-extraction", { dir: tmpDir });
    assert.strictEqual(read, undefined);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm run test -- tests/unit/workflows/separations/step-cache-kuali-extraction.test.ts`

Expected: PASS (2/2) — this test exercises the existing step-cache primitive. If it fails, investigate step-cache wiring.

- [ ] **Step 3: Wire cache into the handler**

In `src/workflows/separations/workflow.ts`, add import:
```ts
import { stepCacheGet, stepCacheSet } from "../../core/step-cache.js";
```

Replace the `kuali-extraction` step (~L196-206):

```ts
// before
const kualiData = await ctx.step("kuali-extraction", async () => {
  const kualiPage = await ctx.page("kuali");
  const ucpathPage = await ctx.page("ucpath");
  ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));
  await openActionList(kualiPage);
  await clickDocument(kualiPage, docId);
  return extractSeparationData(kualiPage);
});

// after
const kualiData = await ctx.step("kuali-extraction", async () => {
  const cached = await stepCacheGet<SeparationData>("separations", docId, "kuali-extraction");
  if (cached) {
    log.success(`[Kuali] Extraction cached (doc ${docId}) — reusing`);
    // Still attach the UCPath dialog handler for later phases
    const ucpathPage = await ctx.page("ucpath");
    ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));
    return cached;
  }
  const kualiPage = await ctx.page("kuali");
  const ucpathPage = await ctx.page("ucpath");
  ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));
  await openActionList(kualiPage);
  await clickDocument(kualiPage, docId);
  const extracted = await extractSeparationData(kualiPage);
  await stepCacheSet("separations", docId, "kuali-extraction", extracted).catch(() => {});
  return extracted;
});
```

(`SeparationData` should already be imported from schema.ts; if not, add it.)

- [ ] **Step 4: Run full separations tests + typecheck**

Run: `npm run typecheck && npm run test -- tests/unit/workflows/separations/`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/separations/workflow.ts tests/unit/workflows/separations/step-cache-kuali-extraction.test.ts
git commit -m "feat(separations): step-cache kuali-extraction — skip re-extract on retry (2h TTL)"
```

### Task C.7: Transaction-number extraction assertion

**Files:**
- Modify: `src/workflows/separations/workflow.ts`

- [ ] **Step 1: Find the txn # extraction site**

Grep line 398 area:
```ts
transactionNumber = submitResult.transactionNumber ?? "";
```

- [ ] **Step 2: Add assertion**

Replace with:

```ts
transactionNumber = submitResult.transactionNumber ?? "";
if (submitResult.success && !transactionNumber) {
  throw new Error(
    "Transaction submitted but transaction number could not be extracted — aborting before Kuali finalization writes empty value",
  );
}
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test -- tests/unit/workflows/separations/`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/separations/workflow.ts
git commit -m "fix(separations): fail loud when transaction # extraction returns empty instead of writing blank to Kuali"
```

### Task C.8: Phase C sanity — full test + typecheck

- [ ] **Step 1: Run full suite**

```bash
npm run typecheck:all && npm run test
```

Expected: PASS everything. Investigate failures before Phase D.

---

## Phase D — Onboarding + I9 + CLI

### Task D.1: `closeAllKendoWindows` helper + wire into I9 flows

**Files:**
- Create or modify: `src/systems/i9/navigate.ts`
- Modify: `src/systems/i9/search.ts`
- Modify: `src/systems/i9/create.ts`
- Create: `tests/unit/systems/i9/close-kendo-windows.test.ts`

- [ ] **Step 1: Check if navigate.ts exists**

Run: `ls src/systems/i9/navigate.ts 2>/dev/null || echo "missing"`

If missing, create it:
```ts
import type { Page } from "playwright";
```

- [ ] **Step 2: Write failing test**

Create `tests/unit/systems/i9/close-kendo-windows.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeAllKendoWindows } from "../../../../src/systems/i9/navigate.js";

describe("closeAllKendoWindows", () => {
  it("calls page.evaluate then page.keyboard.press('Escape') then waits", async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push("evaluate"); },
      keyboard: { press: async (key: string) => { calls.push(`press:${key}`); } },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await closeAllKendoWindows(fakePage as never);
    assert.deepStrictEqual(calls, ["evaluate", "press:Escape", "wait:250"]);
  });

  it("swallows evaluate errors (page may have no k-windows)", async () => {
    const fakePage = {
      evaluate: async () => { throw new Error("no elements"); },
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    };
    await closeAllKendoWindows(fakePage as never);
  });

  it("swallows keyboard errors", async () => {
    const fakePage = {
      evaluate: async () => {},
      keyboard: { press: async () => { throw new Error("boom"); } },
      waitForTimeout: async () => {},
    };
    await closeAllKendoWindows(fakePage as never);
  });
});
```

- [ ] **Step 3: Run test**

Run: `npm run test -- tests/unit/systems/i9/close-kendo-windows.test.ts`

Expected: FAIL — `closeAllKendoWindows` not exported.

- [ ] **Step 4: Implement helper**

In `src/systems/i9/navigate.ts`, add:

```ts
import type { Page } from "playwright";

/**
 * Force-close every visible Kendo UI window modal on the page. Idempotent.
 * Clicks all known close-button selectors inside .k-window, then presses
 * Escape as a fallback for modals that don't render an explicit close.
 *
 * I9's New Employee flow accumulates Kendo windows across the search-then-create
 * path; titles like "titlebar-newUI-4" in today's logs suggest multiple modals
 * were stacked when a click was blocked. Always call this before clicking
 * interactive elements on the dashboard after a dialog interaction.
 */
export async function closeAllKendoWindows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const closers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".k-window .k-window-action, .k-window .k-i-close, .k-window [aria-label='Close']",  // allow-inline-selector
      ),
    );
    closers.forEach((el) => el.click());
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}
```

- [ ] **Step 5: Run test**

Run: `npm run test -- tests/unit/systems/i9/close-kendo-windows.test.ts`

Expected: PASS (3/3).

- [ ] **Step 6: Wire into search.ts**

In `src/systems/i9/search.ts`, add import:
```ts
import { closeAllKendoWindows } from "./navigate.js";
```

Before `return parseSearchResults(page);` (~L75), add:
```ts
await closeAllKendoWindows(page);
```

- [ ] **Step 7: Wire into create.ts with retry**

In `src/systems/i9/create.ts`, add import:
```ts
import { closeAllKendoWindows } from "./navigate.js";
```

Replace line 30 single-click:
```ts
await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
```

With:
```ts
await closeAllKendoWindows(page);
try {
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
} catch (e) {
  log.warn(`Create New I-9 click blocked — force-closing modals and retrying: ${errorMessage(e)}`);
  await closeAllKendoWindows(page);
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
}
```

Ensure `log` and `errorMessage` are already imported (they are).

- [ ] **Step 8: Whitelist inline selector (if test enforces it)**

Run: `npm run test -- tests/unit/systems/inline-selectors.test.ts`

If it fails on `.k-window ...`, the `// allow-inline-selector` comment on the line inside evaluate() should cover it. If not, update the test whitelist or adjust the comment placement.

- [ ] **Step 9: Full typecheck + tests**

Run: `npm run typecheck && npm run test`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/systems/i9/ tests/unit/systems/i9/close-kendo-windows.test.ts
git commit -m "fix(i9): force-close all Kendo windows before Create New I-9 click + retry on block"
```

### Task D.2: Onboarding tab-walk audit

**Files:**
- Modify (possibly): `src/workflows/onboarding/enter.ts`

- [ ] **Step 1: Read tab-walk section**

Run: `grep -n "Personal Data\|Job Data\|Earns Dist\|Employee Experience\|waitForPeopleSoftProcessing" src/workflows/onboarding/enter.ts`

Expect to find plan.add entries for each of the 4 tabs and a final re-click of Personal Data.

- [ ] **Step 2: Confirm waitForPeopleSoftProcessing between tabs**

Each tab-switch plan step should have:
```ts
await frame.getByRole("tab", { name: "..." }).click({ timeout: 10_000 });
await page.waitForTimeout(3_000);
await waitForPeopleSoftProcessing(frame, 10_000);
```

If any tab click lacks the waitForPeopleSoftProcessing follow-up, add it.

- [ ] **Step 3: Commit if any changes were made**

```bash
git add src/workflows/onboarding/enter.ts
git commit -m "fix(onboarding): waitForPeopleSoftProcessing after every Smart HR tab click"
```

If no changes needed, skip the commit.

Note: the actual `waitForSaveEnabled` from Task C.5 also applies to onboarding's final save — onboarding calls `clickSaveAndSubmit` through the same `src/systems/ucpath/transaction.ts`. No additional edit needed.

### Task D.3: Add `onboarding` CLI command + batch

**Files:**
- Modify: `src/workflows/onboarding/index.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`

- [ ] **Step 1: Read current onboarding index**

Run: `cat src/workflows/onboarding/index.ts`

Note the current exports (`runOnboarding`, `runParallel`, `onboardingWorkflow`).

- [ ] **Step 2: Add runOnboardingPositional**

In `src/workflows/onboarding/index.ts`, after `runParallel`, add:

```ts
import { runWorkflowBatch } from "../../core/workflow.js";
import { trackEvent } from "../../tracker/jsonl.js";

/**
 * Run onboarding for N emails in pool mode. Pool size defaults to min(N, 4).
 * Unlike runParallel (which reads batch.yaml), this takes emails directly.
 */
export async function runOnboardingPositional(
  emails: string[],
  opts: { dryRun?: boolean; poolSize?: number } = {},
): Promise<void> {
  if (opts.dryRun) {
    log.step(`Dry run: would onboard ${emails.length} email(s): ${emails.join(", ")}`);
    return;
  }
  const poolSize = opts.poolSize ?? Math.min(emails.length, 4);
  const now = new Date().toISOString();
  const items = emails.map((email) => ({ email }));

  const result = await runWorkflowBatch(onboardingWorkflow, items, {
    poolSize,
    deriveItemId: (item) => (item as { email: string }).email,
    onPreEmitPending: (item, runId) => {
      const email = (item as { email: string }).email;
      trackEvent({
        workflow: "onboarding",
        timestamp: now,
        id: email,
        runId,
        status: "pending",
        data: { email },
      });
    },
  });

  log.success(`Onboarding batch complete: ${result.succeeded}/${result.total} succeeded`);
  if (result.failed > 0) process.exitCode = 1;
}
```

Ensure `log` is imported at the top of the file. Adjust `runWorkflowBatch`'s generic params if typescript complains — match the existing `runParallel` call signature.

- [ ] **Step 3: Add `onboarding` command to cli.ts**

In `src/cli.ts`, import:
```ts
import { runOnboardingPositional } from "./workflows/onboarding/index.js";
```

After the `start-onboarding` command (~L117), add:

```ts
// ─── onboarding (positional emails) ───

program
  .command("onboarding")
  .description("Run onboarding for one or more emails (positional). Pool size = min(N, 4), override with --workers.")
  .argument("<emails...>", "Employee email(s)")
  .option("--dry-run", "Preview without running")
  .option("--workers <N>", "Pool size override", parseInt)
  .action(async (emails: string[], options: { dryRun?: boolean; workers?: number }) => {
    try { validateEnv(); } catch { process.exit(1); }

    if (options.workers !== undefined && (options.workers < 1 || !Number.isFinite(options.workers))) {
      log.error("--workers must be a positive integer");
      process.exit(1);
    }

    try {
      await runOnboardingPositional(emails, { dryRun: options.dryRun, poolSize: options.workers });
    } catch (error) {
      log.error(`Onboarding failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Add package.json scripts**

In `package.json`, under `"scripts"`, add (next to the existing `start-onboarding` entries):

```json
"onboarding":     "node --import tsx/esm --env-file=.env src/cli.ts onboarding",
"onboarding:dry": "node --import tsx/esm --env-file=.env src/cli.ts onboarding --dry-run",
```

- [ ] **Step 5: Dry-run smoke test**

Run:
```bash
npm run onboarding:dry -- a@example.com b@example.com
```

Expected: logs "Dry run: would onboard 2 email(s): a@example.com, b@example.com" and exits cleanly.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflows/onboarding/index.ts src/cli.ts package.json
git commit -m "feat(cli): npm run onboarding <email1> <email2> ... — positional batch with default pool min(N,4)"
```

### Task D.4: Phase D sanity

- [ ] **Step 1: Run full suite**

```bash
npm run typecheck:all && npm run test
```

Expected: PASS.

---

## Phase E — Observability + docs

### Task E.1: Normalize event timestamp at read time

**Files:**
- Modify: `src/tracker/dashboard.ts`
- Modify: `src/tracker/session-events.ts`
- Create: `tests/unit/tracker/timestamp-normalization.test.ts`

- [ ] **Step 1: Find all event-sort sites**

Run: `grep -n "localeCompare\|\.timestamp" src/tracker/dashboard.ts | head -20`

Today's gemini patch coalesced `a.timestamp ?? ""`. The root cause is mixed `timestamp` (ISO string) vs `ts` (numeric, from `screenshot` events).

- [ ] **Step 2: Write failing test**

Create `tests/unit/tracker/timestamp-normalization.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventSortKey } from "../../../src/tracker/dashboard.js";

describe("getEventSortKey", () => {
  it("returns ISO timestamp when present", () => {
    const key = getEventSortKey({ type: "workflow_start", timestamp: "2026-04-20T10:00:00.000Z" } as never);
    assert.strictEqual(key, "2026-04-20T10:00:00.000Z");
  });

  it("falls back to ts (numeric) converted to ISO when timestamp missing", () => {
    // Math: 1776722504377 ms = 2026-04-20T22:01:44.377Z
    const key = getEventSortKey({ type: "screenshot", ts: 1776722504377 } as never);
    assert.strictEqual(key, "2026-04-20T22:01:44.377Z");
  });

  it("returns empty string when neither timestamp nor ts is present", () => {
    const key = getEventSortKey({ type: "unknown" } as never);
    assert.strictEqual(key, "");
  });
});
```

- [ ] **Step 3: Run test**

Run: `npm run test -- tests/unit/tracker/timestamp-normalization.test.ts`

Expected: FAIL — `getEventSortKey` not exported.

- [ ] **Step 4: Implement helper**

In `src/tracker/dashboard.ts`, add near the top (with other utility functions):

```ts
/**
 * Canonical sort key for a session event. Events emitted by
 * emitScreenshotEvent use numeric `ts` (ms since epoch) while other
 * event emitters use ISO `timestamp`. Normalize both into an ISO string
 * so localeCompare sorts correctly.
 */
export function getEventSortKey(e: { timestamp?: string; ts?: number }): string {
  if (typeof e.timestamp === "string" && e.timestamp.length > 0) return e.timestamp;
  if (typeof e.ts === "number" && Number.isFinite(e.ts)) return new Date(e.ts).toISOString();
  return "";
}
```

- [ ] **Step 5: Replace the gemini-patched sort sites**

Find the localeCompare sites:
- `src/tracker/dashboard.ts:~1155`: `filtered.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));`
- `src/dashboard/components/LogStream.tsx:~56`: similar pattern

Replace in `dashboard.ts`:
```ts
filtered.sort((a, b) => getEventSortKey(a).localeCompare(getEventSortKey(b)));
```

Frontend LogStream.tsx can stay with the `?? ""` coalesce — the frontend doesn't have direct access to both fields in the same payload (screenshot events come via a different SSE stream). Leave the defensive there.

- [ ] **Step 6: Run test**

Run: `npm run test -- tests/unit/tracker/timestamp-normalization.test.ts`

Expected: PASS (3/3).

- [ ] **Step 7: Full tests + typecheck**

Run: `npm run typecheck && npm run test -- tests/unit/tracker/`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tracker/dashboard.ts tests/unit/tracker/timestamp-normalization.test.ts
git commit -m "fix(tracker): normalize event sort key — timestamp | ts | '' (fixes missing-ts root cause behind gemini's defensive localeCompare)"
```

### Task E.2: Crashed-launch placeholder in SessionPanel

**Files:**
- Modify: `src/tracker/dashboard.ts` (rebuildSessionState)
- Modify: `src/dashboard/components/SessionPanel.tsx`

- [ ] **Step 1: Find rebuildSessionState**

Run: `grep -n "rebuildSessionState\|workflow_start\|workflow_end" src/tracker/dashboard.ts | head -20`

- [ ] **Step 2: Add crashed-launch detection**

Inside `rebuildSessionState`, after collecting `workflow_start` and `workflow_end` events, identify instances where:
- `workflow_start` emitted
- `workflow_end` finalStatus=failed emitted
- Zero `browser_launch` events between them

For those instances, synthesize a `SessionState` entry with `active: false` and a `crashedOnLaunch: true` flag. Add the flag to the state type:

```ts
// In whatever types file defines SessionWorkflow / SessionState:
export interface SessionWorkflow {
  instance: string;
  runId: string;
  // ... existing fields ...
  crashedOnLaunch?: boolean;
}
```

Inside `rebuildSessionState`, when encountering such an instance, set `crashedOnLaunch: true` on its entry.

- [ ] **Step 3: Render placeholder in SessionPanel**

In `src/dashboard/components/SessionPanel.tsx` (or `WorkflowBox.tsx`), when `wf.crashedOnLaunch` is true, render a red-subtitled placeholder:

```tsx
{wf.crashedOnLaunch ? (
  <span className="text-[10px] text-destructive mt-1 italic">
    Launch failed — check Queue row for details
  </span>
) : (
  // existing children (browsers, etc.)
)}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build:dashboard`

Expected: PASS.

- [ ] **Step 5: Manual smoke**

Start `npm run dashboard`, then simulate a crash by manually appending a `workflow_start` + `workflow_end failed` pair (no browser_launch) to `.tracker/sessions.jsonl` with a unique instance name. Refresh; the SessionPanel should show the placeholder.

(If creating the test data is painful, this step can be deferred to real-world observation — mark as manual follow-up.)

- [ ] **Step 6: Commit**

```bash
git add src/tracker/dashboard.ts src/dashboard/components/SessionPanel.tsx
git commit -m "feat(dashboard): show 'Launch failed' placeholder for workflows that crash before browser_launch"
```

### Task E.3: runId format audit (spike, small commit or note)

**Files:**
- Investigation only, possible one-line changes in `src/workflows/onboarding/parallel.ts`

- [ ] **Step 1: Grep for the emit site**

Run:
```bash
grep -rn "runId.*#\|#.*runId\|\\${.*}#" src/workflows/ src/tracker/ | grep -v test | head -20
```

- [ ] **Step 2: Classify findings**

Expected: the `{id}#N` format comes from either:
- Onboarding's `parallel.ts` (`runParallel`) if it maintains its own numbering
- Separations' CLI adapter if it pre-assigns runIds
- Legacy `withTrackedWorkflow` default (check `src/tracker/jsonl.ts` readRunsForId logic)

- [ ] **Step 3: Document findings in a CLAUDE.md note**

In `src/tracker/CLAUDE.md`, append under Lessons Learned:

```md
- **2026-04-21: runId format coexists.** The kernel emits `randomUUID()` for every new run. Legacy pre-kernel paths (onboarding's `parallel.ts`, anything pre-assigning `preAssignedRunId`) emit `{id}#N`. Both live in sessions.jsonl. The dashboard's `{id}#1` synthesis (line ~765) is a SECOND fallback used only when an entry has no runId at all. Deleting the `RUNID_FALLBACK_UNTIL = 2026-04-26` pid-window fallback is safe once no emitters remaining without runId — audit per that date.
```

- [ ] **Step 4: Commit**

```bash
git add src/tracker/CLAUDE.md
git commit -m "docs(tracker): document runId format coexistence (UUID from kernel, {id}#N from legacy)"
```

### Task E.4: Step-cache explainer doc

**Files:**
- Create: `docs/step-cache.md`

- [ ] **Step 1: Write the doc**

Create `docs/step-cache.md`:

```markdown
# Step-Cache — Skip Expensive Read-Only Work on Retry

Companion to `src/core/idempotency.ts`. Pattern-twin: idempotency prevents double-writes; step-cache prevents double-reads.

## When to use

A step is a good cache candidate when ALL of:

- It's **read-only** (extract, scrape, search) — not submit/save/write
- It's **deterministic given the inputs** (same docId + same day → same data)
- It's **expensive** (>3s) — caching saves meaningful retry time
- Its output **fits in JSON** (no Playwright pages, no streams, no buffers)

## What's opted in today

| Workflow | Step | Reason |
|----------|------|--------|
| onboarding | `extraction` | CRM scrape takes ~25s, re-run after a later-step failure shouldn't re-scrape |
| separations | `kuali-extraction` | Kuali extract takes ~8s, re-runs on same-day retry |

## What should NEVER be cached

- `ucpath-transaction` — mutating submit
- `kuali-finalization` — writes back to Kuali
- `kronos-search` — depends on current UKG state
- Any auth step (Duo freshness matters)

## How to opt a step in

```ts
import { stepCacheGet, stepCacheSet } from "../../core/step-cache.js";

await ctx.step("my-step", async () => {
  const cached = await stepCacheGet<MyOutput>("my-workflow", itemId, "my-step");
  if (cached) {
    log.success("[MyStep] Cached — reusing");
    return cached;
  }
  const result = await doExpensiveWork();
  await stepCacheSet("my-workflow", itemId, "my-step", result).catch(() => {});
  return result;
});
```

Emit is best-effort; a write failure never masks the cached value.

## Storage + TTL

- Location: `.tracker/step-cache/<workflow>-<itemId>/<step>.json`
- One JSON per step, atomic-written
- Default read TTL: 2 hours
- Default on-disk lifetime: 7 days (pruned by `pruneOldStepCache`)

## Observability

On a cache hit, `stepCacheGet` emits a `cache_hit` session event. The dashboard StepPipeline decorates cached step dots blue with a ❄ glyph and surfaces hits in the Events tab. Footer reads "N of M steps reused from cache."

## How to clear

```bash
# Clear one step
rm .tracker/step-cache/separations-3917/kuali-extraction.json

# Clear all cache for one item
rm -rf .tracker/step-cache/separations-3917/

# Clear everything
rm -rf .tracker/step-cache/
```

Or programmatically:
```ts
import { stepCacheClear } from "../../core/step-cache.js";
await stepCacheClear("separations", "3917");          // all steps for this item
await stepCacheClear("separations", "3917", "kuali-extraction");  // one step
```

## History

- **2026-04-18** — Primitive shipped. Onboarding `extraction` opts in.
- **2026-04-21** — Separations `kuali-extraction` opts in. This doc written.

Design rationale: `docs/superpowers/specs/2026-04-18-step-cache-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/step-cache.md
git commit -m "docs: step-cache usage explainer (answers 'how does step cache work for onboarding and separations?')"
```

Note: `docs/` may or may not be gitignored like `docs/superpowers/` was. Check `git status` — if `docs/step-cache.md` shows up without `-f`, drop the `-f`.

### Task E.5: Phase E sanity

- [ ] **Step 1: Run full suite**

```bash
npm run typecheck:all && npm run test
```

Expected: PASS.

- [ ] **Step 2: Build dashboard**

```bash
npm run build:dashboard
```

Expected: builds without error; bundle size similar to current.

---

## Final verification

- [ ] **Run all phases end-to-end tests**

```bash
npm run typecheck:all && npm run test && npm run build:dashboard
```

All pass.

- [ ] **Manual smoke test**

1. Start `npm run dashboard` in one terminal
2. Open http://localhost:5173
3. Verify: no FAILURE card with screenshots under the pipeline; auth chip shows hover popover; "Last day worked" has no colon in separations comment preview
4. Stop dashboard

- [ ] **Verify multi-process separations (requires Duo — user must run)**

In terminal 1: `npm run separation 3910`
In terminal 2 (while #1 is running): `npm run separation 3860`

Expected: both proceed past UKG launch without ProcessSingleton errors. Both appear in the dashboard Sessions panel.

- [ ] **Verify `npm run onboarding`**

```bash
npm run onboarding:dry a@example.com b@example.com c@example.com
```

Expected: logs "Dry run: would onboard 3 email(s)".

---

## Success criteria (from spec §14)

- [ ] Two parallel `npm run separation` calls coexist (no ProcessSingleton)
- [ ] Re-run of a failed separation reuses cached Kuali extraction
- [ ] Job Summary failure marks run as `failed` — no silent-empty txn # writes
- [ ] `npm run onboarding a@x.com b@x.com` runs both with pool size 2
- [ ] Stale Kendo modal no longer blocks Create New I-9
- [ ] Save-and-Submit waits for enabled; reports "disabled after N seconds" if not
- [ ] Dashboard: FAILURE card gone, auth chip hover popover, partial timer, no-colon comment
- [ ] `docs/step-cache.md` exists and answers the how-does-step-cache-work question
- [ ] Working tree clean (gemini diffs committed, scratch files gitignored)
