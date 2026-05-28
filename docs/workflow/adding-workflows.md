# Adding Workflow Delegation Documentation

## UI Copy Rules To Preserve

| Place | Current/desired rule |
|---|---|
| Oath default title | `Oath · <last4 of run id>`. This is the default title/secondary id for file preview context, not the final person row title. |
| Oath final signature row title | Person's name. If unavailable, fall back to EID/search input, not raw OCR retry task id. |
| Oath single file preview row title | PDF filename. |
| Oath multiple file group title | Shared Oath default title; member rows are PDF filenames. |
| Batch group footer | Usual time/run/footer controls without raw parent run id beside the run number. |
| OCR workflow footer | OCR preview/member rows may show the Oath default title beside the run number when the preview is for Oath. |
| Person Lookup title | Resolved person/EID should win over technical `ocr-retry-*` ids. |
| Status badges | Badges should describe what happened: Queued, Running, Needs review, Done, Skipped/Existing, Cancelled, Failed, Not found. They are not separate arbitrary tags. |

## Known Sharp Edges

- A group row is often just a display group. Do not assume group cancel exists because group retry/delete exists.
- `/api/ocr/discard-prepare` is the file-scope cancel path for OCR preview; it is stronger than generic queued/running cancel.
- OCR utility Person Lookup rows use normal count-based grouping: one child is a single row; multiple siblings become a batch surface.
- Multi-PDF Oath Signature behaves as multiple single-file OCR preview runs grouped for display.
- Daemon stop is operational control. It stops workers; it is not the same as a clean cancellation decision for every related row.
- Some workflows exist in metadata but are not exposed through the dashboard upload-run or input-run registry.
- Parent dependency behavior depends on policy. Oath Upload signature children use `block_parent` on failure and cascade-capable dependencies, but dashboard buttons still need the correct endpoint to apply tree-wide cancellation.

## How To Add A New Workflow

1. **Kernel workflow** - `defineWorkflow({ archetype, runtimePolicy, operatorSubject, detailFields, ... })`. Spread `DEFAULT_WORKFLOW_RUNTIME_POLICY` unless the workflow needs delegation/preview/memberRow/prepRow overrides.
2. **Runtime policy** - declare cancel/retry/delete scopes in `runtimePolicy.rowActions` / `groupActions`. OCR-style file-scope cancel uses the OCR discard action path. Utility fan-out uses normal row shape plus `parentRunId`; avoid OCR-only flat-member policy.
3. **Architecture guards** - `tests/unit/architecture/archetype-coverage.test.ts` requires `archetype:`; `tests/unit/architecture/runtime-policy-coverage.test.ts` requires `runtimePolicy:` and validates action descriptors.
4. **Dashboard** - no frontend registry edits. Queue rows pick up titles/actions from projections automatically once the workflow registers and emits tracker rows with the right `data.archetype` stamps.
5. **Docs** - add the workflow to [README.md](README.md) and create or update the workflow-specific page with what the workflow does, what it delegates to, and what cancel/retry means for each scope.
