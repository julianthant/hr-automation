# Rebuild demo

This directory is a synthetic, dev-only preview of the rebuild dashboard. It may model proposed wire
contracts, but it must not call production workflow start paths or claim an unimplemented capability is
live.

## Run launcher

- `DemoRunStart.tsx` owns one workflow-first launcher: desktop keeps the workflow rail; narrow layouts
  replace it with a workflow select so the task column remains usable.
- The launcher workspace is a compact one-column dialog beside the workflow rail. Its compact numbered
  wizard always begins with `Input`, derives `Steps`, `Values`, and `Options` from current customization
  in causal order, and ends with `Confirm`. The ordinary path is `Input -> Confirm`; there is no old
  Review stage or example-value row. The path uses the launcher's original compact ruled-strip treatment:
  small numbered circles, muted inactive labels, tight arrows, and a full-width bottom divider. It is
  the first workspace row, above the workflow title and gear. On desktop it shares the filter row's exact
  height, and its divider crosses the workspace padding to form one continuous rule with the filter rail.
- The workflow title has one shared non-modal Radix-backed gear dropdown. It is anchored below the trigger,
  overlays the form without reflowing it, closes on outside pointer or Escape, returns focus to the gear,
  and exposes checkbox-menu semantics. `Default steps` and `Default options` begin checked, so no
  customization stages render on the ordinary path.
- Unchecking `Default steps` adds the `Steps` stage. Skipping a workflow step then adds `Values` with
  the required replacement inputs. Unchecking `Default options` adds the `Options` stage.
- Shared queue, safety, and destination controls live only in that opt-in `Options` stage; they must
  not become a permanent inspector rail. The controls render directly on the launcher surface rather
  than inside a separate recessed panel.
- A workflow timeline comes from `StartCapabilityWire.timeline`. All declared steps start selected.
- A skipped step promotes its `replacementInputs` into `Values`. Next remains blocked there until every
  promoted input is non-blank. Duplicate replacement keys render once.
- Input and dynamic stages end in `Next`; only the terminal `Confirm` stage may render `Start run` or
  the spreadsheet handoff command. Confirm summarizes scope and deviations without restoring the old
  verbose Review surface.
- Safety gates may be visible and locked. Never make a safety gate bypassable to make the prototype look
  flexible.
- Phone capture is not offered by the launcher. Upload and typed input are the supported document-entry
  shapes in this prototype. The launcher model excludes capture before choosing its initial method; do
  not merely hide a capture tab after state has already selected it.

## Dated lessons

- **2026-08-28 — a modal dropdown nested in a modal dialog makes the parent body an outside target.**
  Radix `DropdownMenu` defaults to `modal=true`; after opening the launcher gear, the next pointer click
  inside the launcher dismissed both layers. Keep this menu `modal={false}` so outside interaction closes
  only the menu while the parent dialog remains open; Escape still restores focus to the gear.
- **2026-08-28 — optional inputs belong to the full workflow, not to every custom run.** When every step
  is selected, the workflow resolves its downstream values and no manual replacement fields appear.
  Turning a step off makes the values that step would have supplied mandatory before Start. Showing the
  dependency beside the timeline prevents a custom run from reaching enqueue with an incomplete plan.
- **2026-08-28 — customization is an exception path, not the launcher scaffold.** A permanently visible
  timeline and verbose Review surface made the default run pay for decisions it did not need. The
  launcher now has one column and a lean terminal Confirm; the gear opts into Steps or Options, and
  Values appears only as the consequence of a skipped step.
- **2026-08-28 — initialize the launcher from the same filtered model it renders.** Post-paint workflow
  setup briefly painted every step as skipped, while hiding capture only in the tabs still allowed state
  to select it. Fresh state now starts with the workflow's full timeline and its first non-capture method.
