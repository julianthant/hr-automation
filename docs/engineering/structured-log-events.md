# Structured log events

A small, **closed set of stable event names** stamped onto run-scope log lines
so observers — the operator dashboard and, critically, the **Tier-1 delegation
test harness** — can recognize specific lifecycle/delegation/cancel moments
without parsing free-text messages.

These names are a **contract**. The Tier-1 harness drives the real daemon
running stub handlers and cannot inject promise latches into handler bodies;
instead it **tails `logs/<workflow>-<date>.jsonl`** under a temp tracker root and
`await`s until a named event appears (its `waitForEvent`). The events here are
that synchronization primitive — renaming any one of them is a **breaking
change** (update every `waitForEvent("...")` call and any other tailer in
lockstep). Adding a new name is additive and safe.

## How they're stamped

- The name lives on `StructuredLogEvent.event` (`src/domain/log-events.ts`), a
  `LogEventName` union. It flows through `log.*({ ..., event })` →
  `appendFromContext` → `appendLogEntry` and persists to
  `logs/<workflow>-<date>.jsonl` because `LogEntry extends
  Partial<StructuredLogEvent>` (the `...extra` spread carries any new field).
- Only **run-scope** `log.*` calls persist to the run log. Daemon-scope lines
  (outside a run) route to the session log via `emitDaemonLog` and are **not**
  part of this contract.
- `logs/` JSONL is written with `appendFileSync` + `O_APPEND`, so a tailer's
  read-after-write is race-free (see `src/tracker/CLAUDE.md`).

## Identity fields a tailer matches on

Every event line carries the standard run-log identity stamped by the log
context, plus event-specific fields:

| Field | Source | Always present? |
|---|---|---|
| `workflow` | log context | yes (the file discriminator) |
| `runId` | log context (`setLogRunId`) | yes for run-scope lines — **the primary match key** |
| `itemId` | log context | yes |
| `event` | the emit site | only on event lines |
| `step` | the emit site | on `step:*`, terminal/cancel lines |
| `childWorkflow` | the emit site | on `delegation:children-spawned` |
| `count` | the emit site | on `delegation:children-spawned`, `ocr:awaiting-approval` |
| `occasion` | the emit site | on terminal/cancel lines |

**`traceId` is intentionally NOT stamped on these events.** Threading the
frozen `data.__traceId` (which rides tracker *rows*, not log lines) into each
emit site is invasive and would compete with the existing trace mechanism. The
`runId` is already on every run-scope log line and uniquely scopes a run, so the
harness matches on `runId`. (If a future need arises, thread the frozen id via
`findFrozenTraceId` — do not add a competing trace field.)

## The event set

| `event` | Fires when | Where (file · function) | Carries | Annotated? |
|---|---|---|---|---|
| `step:start` | A kernel step boundary is announced, before the body runs. The harness uses this to know a (child) run "reached stage X". | `src/core/kernel/stepper.ts` · `Stepper.announce` (the existing `Phase: <name>` line) | `step` | annotated |
| `step:done` | A step body resolved successfully. | `src/core/kernel/stepper.ts` · `Stepper.step` (success path) | `step`, `durationMs` | new line |
| `delegation:children-spawned` | A handler fans out via `ctx.delegateTo` / `ctx.delegateToAll`. Emitted on the **parent's** run log. | `src/core/delegate.ts` · `emitChildrenSpawned` (called from the public `delegateTo`/`delegateToAll` in `buildDelegateApi`) | `childWorkflow`, `count`, `category:"delegation"`, `occasion:"started"` | new line |
| `ocr:awaiting-approval` | The OCR orchestrator parks at the awaiting-approval gate (prep complete, waiting for the operator). | `src/workflows/ocr/orchestrator.ts` · `runOcrOrchestrator` (the "preparation complete" line) | `step:"awaiting-approval"`, `count` (record count), `category:"ocr"`, `occasion:"waiting"` | annotated |
| `cancel:requested` | A run observes an operator cancel at a step boundary and turns it into a `CancelledError`. The run-scope counterpart of the daemon's `cancel_task` command (which is daemon-scope and not on the run log). | `src/core/kernel/stepper.ts` · `Stepper.throwCancelled` | `step` (the step being cancelled), `category:"queue"`, `occasion:"cancelled"` | new line |
| `run:terminal` | A run reaches its terminal emit. Exactly one per run. Branch on `occasion` for the outcome. | `src/tracker/tracked-workflow.ts` · `withTrackedWorkflow` (success/done + catch) | `occasion: "completed" \| "failed" \| "cancelled"`, `step` | success: new line · failure/cancel: annotated |

### Notes on a few sites

- **`delegation:children-spawned` is emitted at the public API**, not inside
  `delegateToImpl`/`delegateToAllImpl`. `delegateToAll`'s in-process pool
  re-enters `delegateToImpl` per child, so emitting deeper would double-count.
  One fan-out call → one event with the real `count`.
- **`run:terminal` is the deterministic run-completion signal.** A harness
  `await waitForEvent("run:terminal", { runId })` resolves once the run's
  terminal row is written. On the failure/cancel path, `step` is the encoded
  `<step>:failed:<error>` string `withTrackedWorkflow` keeps in `lastStep` —
  scope on `runId` + `occasion`, not the exact `step` text.
- **`cancel:requested` is run-scope on purpose.** The daemon's `cancel_task`
  worker-command handler runs in the command-poll loop (daemon-scope → session
  log). The Stepper's `throwCancelled` is where the in-flight run actually
  observes the aborted signal, so that's the line a run-log tailer can see.

## Proof / tests

- `tests/unit/domain/log-events.test.ts` — the schema: `event`/`count` survive
  `normalizeLogEvent`; the closed name set is pinned.
- `tests/unit/core/log-event-emission.test.ts` — drives real workflows via
  `runWorkflow` against a temp tracker dir and asserts the
  `logs/<workflow>-<date>.jsonl` file carries `step:start`, `step:done`,
  `run:terminal` (completed + failed), and `delegation:children-spawned`
  (`childWorkflow` + `count`) with `runId` populated. The assertions mirror what
  `waitForEvent` will filter on.
