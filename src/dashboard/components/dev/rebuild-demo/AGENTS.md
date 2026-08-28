# Rebuild demo

This directory is a synthetic, dev-only preview of the rebuild dashboard. It may model proposed wire
contracts, but it must not call production workflow start paths or claim an unimplemented capability is
live.

## Run launcher

- `DemoRunStart.tsx` owns one workflow-first launcher: desktop keeps the workflow rail; narrow layouts
  replace it with a workflow select so the task column remains usable.
- At wide widths, the launcher workspace is a two-column split: starting inputs and promoted required
  values on the left, the workflow timeline on the right. It collapses to one DOM-ordered column at
  narrow widths: input, timeline, promoted requirements, then options.
- The ordinary path is `Input -> Review -> Start`. Result state belongs to the run detail after enqueue,
  not to the launcher navigation.
- Shared queue, safety, and destination controls stay collapsed under `Options`; they must not become a
  permanent inspector rail.
- A workflow timeline comes from `StartCapabilityWire.timeline`. All declared steps start selected.
- A skipped step promotes its `replacementInputs` into the form. Review remains blocked until every
  promoted input is non-blank. Duplicate replacement keys render once.
- Safety gates may be visible and locked. Never make a safety gate bypassable to make the prototype look
  flexible.
- Phone capture is not offered by the launcher. Upload and typed input are the supported document-entry
  shapes in this prototype. The launcher model excludes capture before choosing its initial method; do
  not merely hide a capture tab after state has already selected it.

## Dated lessons

- **2026-08-28 — optional inputs belong to the full workflow, not to every custom run.** When every step
  is selected, the workflow resolves its downstream values and no manual replacement fields appear.
  Turning a step off makes the values that step would have supplied mandatory before Review. Showing the
  dependency beside the timeline prevents a custom run from reaching enqueue with an incomplete plan.
- **2026-08-28 — the timeline and its consequences must remain simultaneously visible.** A full-width
  timeline pushed skipped-step requirements below the fold, separating the operator's action from its
  result. Wide launchers therefore keep inputs left and the timeline right in one scroll surface; narrow
  launchers preserve the same causal order without introducing nested scrolling.
- **2026-08-28 — initialize the launcher from the same filtered model it renders.** Post-paint workflow
  setup briefly painted every step as skipped, while hiding capture only in the tabs still allowed state
  to select it. Fresh state now starts with the workflow's full timeline and its first non-capture method.
