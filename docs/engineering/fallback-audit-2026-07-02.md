# Silent-Fallback Audit — 2026-07-02

**Point-in-time snapshot, not maintained reference.** A codebase-wide sweep for **unverified silent fallbacks** — code that, when an operation fails or expected data is missing, substitutes a plausible-but-wrong value/selector/path and continues, instead of failing loud. In a single-operator tool that submits real UCPath/Kuali/Kronos/OnBase/i9 transactions, this is the most dangerous class of bug: the failure is hidden and wrong data can reach a live HR record.

Guardrail added the same day: root `CLAUDE.md` → **"Fail loud — no unverified silent fallbacks"** (generalizes the UCPath 2026-04-23 no-cross-source-fallback rule to the whole codebase).

## Status — fixes applied (2026-07-02)

Applied in the working tree and **verified** (typecheck clean; targeted + full unit suite green apart from 4 pre-existing failures in a concurrently-edited file `core/e2e/stub-workflows.test.ts`, unrelated to these changes). **Not yet committed** — the working tree held ~130 files of concurrent multi-feature WIP, including co-edits to `transaction.ts`/`per-page.ts`, so committing was deferred to avoid entangling with in-flight work.

| Finding | Fix | Test |
|---|---|---|
| **C2** `parsePayRate` | throws on a digit-free wage instead of returning it verbatim | `transaction.test.ts` (new `parsePayRate` describe) |
| **C6** `per-page.ts` `employeeSigned` | removed the `employeeSigned: true` default injection (omitted → undefined → not-signed) | `per-page.test.ts` (2 tests updated to fail-safe) |
| **C3** `new-kronos/navigate.ts` probe | `.catch(() => ({ match: false }))` — a probe throw no longer confirms the employee | inspection (no page-mock harness; matches sibling + intent) |
| **C9** `EidApprovalBanner.tsx` | requires explicit `json.ok === true`; a malformed 2xx / parse failure is a hard error | — (no dashboard component harness) |
| tracker `parseJsonObject` + `parseDataJson` | `log.warn` on unparseable row JSON instead of silently masking corruption as `{}` | covered by existing tracker suite (691 green) |

**Deferred** (need live verification or careful review of a tested control-plane/live-page contract, unsafe to change blind while away): C1 transaction timeout→success, C4 old-kronos name mismatch, C5 onbase count, C8 dependency poll, C11 partial-cancel, C12 `deriveChildItemId`, C13/C14 person-lookup ambiguity, C16 `"SDCMP"`, the shared `usePostAction` malformed-body cluster, and all HIGH/MEDIUM. See the fix-order section at the bottom.

## How this was produced

Six read-only agents swept `src/` partitioned by area, each returning only genuinely-risky fallbacks (benign/correct defaults excluded). Every **CRITICAL** below plus a sample of HIGH were then **verified by hand against source** (marked ✅). "Benign fallbacks not listed" totals ~514 across all areas — those are correct defaults where absence is a valid state.

## Severity legend

- **CRITICAL** — can silently act on the wrong person or push wrong data into a real HR transaction / report false success.
- **HIGH** — can submit/act-on wrong data, mask a real failure, or corrupt the source of truth under a plausible trigger.
- **MEDIUM** — wrong/misleading outcome under a narrower or less-likely trigger.
- **FIX**: `fail-loud` (throw/surface) · `verify-live` (needs a live check before deciding) · `keep` (justified — listed for completeness).

## Counts

| Area | CRITICAL | HIGH | MEDIUM | LOW/keep |
|---|---|---|---|---|
| `src/systems` | 6 | ~17 | ~13 | ~4 |
| `src/workflows` | 4 | ~14 | ~8 | ~6 |
| `src/core` + `src/control` | 1 | ~13 | ~11 | ~6 |
| `src/services`+`infra`+`domain` | 2 | 3 | 2 | 2 |
| `src/dashboard` | 3 | 5 | ~9 | ~10 |
| `src/tracker`+`utils`+`scripts` | 0 | 2 | 2 | ~2 |
| **Total** | **~16** | **~54** | **~45** | **~30** |

---

## CRITICAL

### C1 ✅ `src/systems/ucpath/transaction.ts:641-648` — timeout on the real submit → false "submitted"
`outcome === "timeout"` with no error banner falls through to `log.success("Transaction saved and submitted")` and proceeds to read the transaction number. A PeopleSoft hang/failure with no `.PSERROR` banner is reported as a successful termination/hire submit. Partial backstop: separations captures `ucpath-transaction-submitted-missing-number` if no T# is later parsed. **FIX: fail-loud** (a timeout is not a confirmation — require the confirmation OK marker).

### C2 ✅ `src/systems/ucpath/transaction.ts:1096-1098` — `parsePayRate` returns the raw wage string
`return match?.[1] ?? wage;` — a non-numeric CRM wage (`"TBD"`, `"Negotiable"`, `"N/A"`) has no digit match and is returned verbatim into the PeopleSoft Compensation Rate field. **FIX: fail-loud** (throw on an unparseable pay rate).

### C3 ✅ `src/systems/new-kronos/navigate.ts:442-443` — identity probe fails open
`.catch(() => ({ match: true, otherEid: null }))` → `if (probe.match) return { ok: true, shownEid: eid }`. Any exception in `verifyTimecardEmployee`'s DOM probe **falsely confirms the correct employee**, so another person's timecard (last-day-worked / sick / holiday) can drive a separation. This gate exists specifically to stop the stale-timecard incident. **FIX: fail-loud** (a probe throw must default to `match:false`, like its intent).

### C4 ✅ `src/systems/old-kronos/reports.ts:343-353` — registers a name-MISMATCHED PDF
Computes `nameMatch = newPdfs[0] === filename`, logs `"MISMATCHES"`, then unconditionally `registerDownloadedReportPdf(dest, filename, employeeId)` and returns `true`. On the filesystem-fallback download path, another employee's PDF is saved and tagged under this employee's ID. **FIX: fail-loud** (do not register on a name mismatch).

### C5 ✅ `src/systems/onbase/navigate.ts:200-201` — `count()` throw treated as "queue empty"
`const leftover = await removeButtons.count().catch(() => 0); if (leftover === 0) return;` — a `count()` exception silently skips `clearLeftoverQueuedDocuments`, so a leftover file from a failed prior attempt gets imported as a **duplicate** HR document (the exact case the function's docstring guards). **FIX: fail-loud** (distinguish a throw from a genuinely-empty queue).

### C6 ✅ `src/services/ocr/per-page.ts:312` — `employeeSigned` defaults to **true** (signed)
`{ rowIndex: idx, employeeSigned: true, ...rec, sourcePage }` — when the vision model **omits** `employeeSigned`, the injected `true` stands, so a blank signature line can be recorded as signed → the record becomes selectable and fans out as a real oath-signature transaction. The schema is now `.nullable().optional()`, so the injection is no longer needed to prevent a record drop; only the dangerous direction remains. **FIX: fail-loud** (omitted → surface for review, not default-signed).

### C7 ✅ `src/services/capture/pdf-bundle.ts:38-40` (+ `server.ts` `handleFinalize`) — blank-PDF synthesis
`if (imagePaths.length === 0) { doc.addPage(); }` synthesizes a structurally-valid blank PDF; `handleFinalize` never checks `photos.length`. A 0-photo finalize feeds a blank document into the OCR/operation pipeline as if a real form was captured (only the mobile client guards it). **FIX: fail-loud** (server-side reject 0-photo finalize; `bundlePhotosToPdf` throws on empty input).

### C8 ✅ `src/dashboard/components/hooks/useTaskDependencies.ts:51-54` — poll error → Approve unblocks
`catch { setSummary(null); setChildren([]); }` and `OcrReviewPane` reads `dependencySummary?.pending ?? 0`. A thrown 1s dependency poll (network blip) clears summary to null → reads "0 pending" → the OCR **Approve** button unblocks while a background person-lookup/i9 enrichment is still running → the operator fans out real writes on incomplete data. (Note: `!res.ok`/`!body.ok` early-returns keep prior state; only a fetch reject clears it.) **FIX: fail-loud** (keep Approve disabled until a successful poll; distinguish "unknown" from "0").

### C9 ✅ `src/dashboard/components/log-panel/EidApprovalBanner.tsx:84-85` — success on malformed 200
`const json = await res.json().catch(() => ({})); if (res.ok && json.ok !== false) { toast.success(...) }`. A non-JSON 200 → `{}` → `json.ok` undefined → `undefined !== false` is true → reports success. This is the **wrong-person EID re-queue** for separations (the highest-stakes gate). **FIX: fail-loud** (require `json.ok === true`; a parse failure is a hard error). Same pattern in `usePostAction.ts:50` / `useWorkflowActionDispatcher.ts:209` (delete-all/retry-all report success on an unparsable body — see H-cluster).

### C10 ✅ `src/dashboard/components/ocr/preview-gate.ts:34` — approval gate is dead code
`derivePreviewApprovalGate` exists but is **never called in production** (grep: only its own test); `OcrReviewPane` renders `PrepReviewPair` without `onPreviewStatusChange`. The "block approval until the scanned page actually rendered" gate does not exist — the operator can Approve (firing a real write) without the source form ever loading. **FIX: fail-loud** (thread `onPreviewStatusChange`, wire the gate into the Approve disabled state).

### C11 ✅ `src/control/actions/perform-workflow-action.ts:279-281` — partial cancel reported as full success
`const succeeded = childResults.filter((r) => r.ok); if (succeeded.length > 0) return okTarget(t, { cancelledDescendants: succeeded.length });` — on the coordinator tree-cancel path, if **any** descendant cancels, it returns `ok` and the descendants that **failed** to cancel are dropped from the result. Operator sees "cancelled" while still-live automations keep running and can submit a real transaction. **FIX: fail-loud** (surface the descendants that did not cancel).

### C12 ✅ `src/workflows/ocr/orchestrator.ts:1072-1078` — `deriveChildItemId` collision fallback + first-match
`const matched = eidLookupEnqueueItems.find(... name/emplId text-match); return matched?.itemId ?? \`ocr-fallback-${runId}-r0\`;`. Two records with the same extracted name/EID collapse to one itemId (first-match), so one person's resolved identity is patched onto a **different** person's oath/EC record before approval (or the other row hangs to timeout). Already fixed in the sibling `buildFanOutItemIdResolver`; missed here. **FIX: fail-loud** (thread the index-unique itemId; throw on a miss).

### C13 `src/workflows/person-lookup/workflow.ts:188-198` + `:393-421` — ambiguous search keeps an arbitrary EID
When the name search is flagged **ambiguous** (multiple distinct EIDs), `emplId`/`resolvedName` are only overwritten when truthy, so the earlier arbitrary `results[0]` EID persists on the row while `activeStatus` says "Ambiguous". Downstream (separations identity-check delegation) treats `emplId` as authoritative and only rejects on invalid **format** — a well-formed but wrong EID can act on the wrong person. **FIX: fail-loud** (clear `emplId`/`resolvedName`/dept/title when `activeStatus === "ambiguous"`).

### C14 `src/workflows/person-lookup/workflow.ts:359-368` — "CRM-only" EID takes first record with any EID
`const withEid = crmRecords.find((r) => r.ucpathEmployeeId); if (withEid) ctx.updateData({ emplId: ..., crmMatch: "crm-only" });` — from a loose token-substring CRM name matcher, with zero UCPath cross-check. If the search returns >1 person, an unverified person's EID is stamped as resolved identity and feeds the active-status lookup. **FIX: fail-loud** (flag ambiguous when >1 CRM record has an EID).

### C15 ✅ `src/workflows/emergency-contact/workflow.ts:253-260` — Save declares success unverified
`Save.click()` → `waitForLoadState("networkidle").catch(() => {})` → `log.success("Saved emergency contact for ...")`. No confirmation / error-banner / re-read check. A rejected save (session timeout, validation error) is reported as success and the contact may never be written. Onboarding + onbase both verify their saves; this one doesn't. **FIX: fail-loud** (assert a save confirmation / absence of error banner, mirror onbase's `classifyOnbasePage`).

### C16 `src/systems/ucpath/person-org-summary.ts:448-467` — fabricated `"SDCMP"` business unit
`businessUnit: assignment?.businessUnit ?? "SDCMP"` (also `emplRecord ?? "0"`, `hrStatus ?? (termDate ? "Inactive" : "Active")`) — when the Employment Instances table fails to parse, a hardcoded `"SDCMP"` is fabricated. `searchByName` filters candidates on `businessUnit === "SDCMP"`, so a non-SDCMP person whose row merely failed to parse gets forced into the SDCMP funnel and can resolve as a false EID match. **FIX: fail-loud** (a parse failure must not fabricate a filter key).

---

## HIGH

### systems
- ✅ `ucpath/transaction.ts:168-176` — same timeout→success pattern at `clickCreateTransaction` (reason-code page never confirmed). **fail-loud**
- `ucpath/transaction.ts:1061-1088` (`findTransactionRowLinkByEid`) — `catch → { txnNumber: null, alreadyAtSmartHR: false }` = "no existing termination" on ANY throw; the duplicate-termination guard can clear the way for a second real duplicate. **verify-live**
- `ucpath/transaction.ts:966-993` (`checkPendingTransactionRowsByEid`) — `catch → return 0` = "0 deleted" on any throw mid-sweep; leaves a stale pending termination while a new one is created. **verify-live**
- `ucpath/job-summary.ts:530-533,800-808` — no empty-guard on `deptId`/`departmentDescription` (only `jobCode` throws); blank department ships to the HDH gate + Kuali. **fail-loud**
- `ucpath/job-summary.ts:241-278` (`ensureJobSummaryDetailPage`) — drills into "first non-terminated row" with no disambiguation; wrong job for a 2+-concurrent-job person. **verify-live**
- `ucpath/job-summary.ts:342-363` (`pickEffectiveDatedRow`) — `if (dated.length === 0) return rows[0]` on a total date-parse miss → arbitrary row's dept/job-code. **fail-loud**
- `ucpath/navigate.ts:357-374` — ambiguous new-hire-vs-rehire branch falls to a one-shot legacy dialog probe; the exact race that "creates a DUPLICATE PERSON". **fail-loud**
- `ucpath/ss-smart-hr.ts:704-716` (`scanSsSmartHrResults`) — `.catch(() => [])` on the DOM evaluate → "no TER" → false `found:false`. **verify-live**
- `ucpath/personal-data.ts:118-162` (`demoteExistingContact`) — `isChecked().catch(() => false)` skips the uncheck, then logs success; the wrong contact stays Primary. **fail-loud**
- `ucpath/selectors.ts:1617-1621` (`oathDateInput`) — `input[id^="EFFDT"]...first()` could overwrite an existing signature-date row. **verify-live**
- `ucpath/selectors.ts:494-508` (`personName`) — falls to the generic bold class `span.PABOLD11TEXT`; backs the separations name↔EID gate. **verify-live**
- `kuali/navigate.ts:425-431` — no matching department → logs error, leaves the required field blank, keeps saving. **fail-loud**
- `kuali/navigate.ts:191-194` — `select.options[selectedIndex]?.text ?? select.value`; raw value misclassifies involuntary vs voluntary. **fail-loud**
- `kuali/selectors.ts:223-227` (`navbarSaveButton`) — final `.or(getByRole("button",{name:"Save"}))` can click any Save on the page. **verify-live**
- `old-kronos/navigate.ts:145-149` — `count < 2` → returns void (success-looking) with the date range never set → wrong pay period. **fail-loud**
- `crm/selectors.ts:83-102` (strategies 3–5, in-code "UNVERIFIED against live CRM") — `rowLabelLastCell` grabs the last `<td>` of any label-matching row → wrong field into onboarding identity. **verify-live**
- `crm/selectors.ts:114-118` (`byName`) — `.or(getByText(sectionName))` broad substring → wrong section, fields read wrong silently. **verify-live / drop the branch**

### workflows
- ✅ `separations/schema.ts:200-216` (`mapReasonCode`) — empty `terminationType` hits `kualiType.includes("") === true` → returns the FIRST map entry, never the `"Resign - No Reason Given"` default → arbitrary wrong VOL_TERM reason on a live termination. **fail-loud** (branch on empty before the fuzzy loop)
- `work-study/enter.ts:67-83` — OKs ANY PeopleSoft alert unread, swallows name readback to `""`, proceeds to a real PayPath submit with no EID-match assertion (work-study has no identity-check). **verify-live → fail-loud**
- `oath-signature/enter.ts:151-163` — sentinel probe `.catch(() => false)` → `alreadyHasOath = true` → skips the entire Add+Save; a required oath is never filed, reported "Skipped (Existing Oath)". **fail-loud**
- `oath-signature/enter.ts:207-213` — Save success logged from the click not throwing, no confirmation/re-read. **verify-live**
- `oath-upload/fill-form.ts:76-79` — `setInputFiles` + fixed 1s sleep, no check the attachment registered before submit → ticket files with the PDF missing. **verify-live**
- ✅ `onboarding/enter.ts:151` — `employeeClassification: data.appointment ?? "5"` submits a specific classification code when the true value is unknown. **fail-loud**
- `ocr/force-research.ts:85-89` + `ocr/retry-page.ts:177-183` (via `services/ocr/fan-out.ts:176-186`) — plain `Map(children.map(c => [JSON.stringify(c.input), c.itemId]))` collides on duplicate input → one record's outcome misapplied. **fail-loud** (per-key FIFO)
- `ocr/retry-page.ts:352-358` (`parseRecords`) — `catch → []` on a present-but-unparseable `data.records` → re-emit drops every prior person except the retried page → operator approves a truncated batch. **fail-loud**
- `emergency-contact/prefilled-record.ts:50-65` — accepts any non-empty string as live `employeeId`, bypassing `^\d{5,}$`; a mistyped EID attaches the contact to the wrong employee. **verify-live** (re-run RecordSchema)
- `emergency-contact/workflow.ts:198-207` (`pickBestContactMatch`) — Levenshtein ≤2 auto-demotes an existing primary contact with no operator gate on non-exact matches. **verify-live**
- `person-lookup/crm-search.ts:261-266` (`pickCrmRecord`) — `matched ?? records[0]` when no EID matches (already `crmMatch:"none"`) → Start Date from a different person. **fail-loud**
- `person-lookup/workflow.ts:524-527` (`crmDatesStep`) — `... ?? crmRecords[0]` → wrong person's dates into the OCR verify comparison. **fail-loud**
- `crm-doc-download/workflow.ts:97-100` — downloads the "latest" search result with no post-selection identity check → another person's onboarding docs. **verify-live**

### core + control
- ✅ `control/ops/worker-control.ts:688-690` — `catch { won = true }`: a DB error is treated as "won the terminal write"; item stays `queued` forever with no daemon. **fail-loud**
- `core/daemon/shutdown.ts:465-470` — same `catch { won = true }`; can release a waiting parent based on a child never actually marked terminal. **fail-loud**
- `core/daemon/worker-commands.ts:50-78` — heartbeat renewal `catch → log.warn` only; a lease-renewal failure lets a peer re-pend the task → double execution of the same real transaction. **fail-loud**
- `control/ops/worker-control.ts:819-823` — `daemonStopped = true` set unconditionally though `stopDaemon` swallows all fetch errors; UI reports stopped while the daemon may be alive mid-automation. **verify-live**
- `control/ops/worker-control.ts:617-648` — three terminal writes each swallowed (`catch {}`), returns truthy itemId; orphaned claim can stay `running` forever while logs say handled. **fail-loud**
- `core/daemon/enqueue-dispatch.ts:346-358` — `supersedePriorRuns` failure → `log.warn` + enqueue anyway → two runs for the same entity → duplicate real transaction. **fail-loud**
- `control/ops/supersede.ts:98-104` — cancel failure logged + skipped, new run enqueues → old + new both active for an irreversible action. **fail-loud**
- `control/ops/retry.ts:77-80,562` (`resolveRetryRosterPath`) — original roster gone → silently uses the most-recently-downloaded roster → retry resolves a different person's record. **fail-loud**
- `core/find-input.ts:94-101` — `catch → null` swallows the `parseJson` throw the codebase's own rule says must fail loud on corrupted `input_json`; a corrupted retry-replay source is silently replaced by a reconstruction. **fail-loud**
- `core/task-store/types.ts:156,162-164` — NULL `control_state` → `'queued'`/`'pending'` (active-looking) instead of an unrecognized-state throw; a corrupted `done` row treated as cancellable-as-queued. **fail-loud**
- `core/kernel/run-one-item.ts:147-176` — the pre-registration throw path: in a pool it drops the item with only a `log.warn` (no tracker row); in the daemon it mislabels a real data/config bug as a routine "browser closed or crashed" cancelled row. **fail-loud**
- `core/kernel/session.ts:830-833` (`hadBrowserDisconnect`) — add-only, unscoped-by-system: once any system disconnects once, every later "Target closed"-shaped error is reclassified `failed → cancelled` for the daemon's uptime → real handler bugs downgraded from red to orange. **fail-loud**
- `control/ops/cancel.ts:225-236` — unknown-to-SQLite-and-registry run assumed dead → overwrites the row to cancelled + `ok:true` with no independent stop check. **verify-live**

### services + dashboard + tracker
- ✅ `services/ocr/forms/oath.ts:33` / `emergency-contact.ts:137` / `verify.ts:48` — `formKind: z.enum([...]).default("oath")` only covers `undefined`; a present-but-non-matching model string fails the record's `safeParse` and the whole record silently vanishes from review (the `documentType` tolerant-coercion fix, never applied to `formKind`). **fail-loud** (tolerant preprocess → `unknown` + warn)
- ✅ `services/llm/normalize-contact.ts:87-119` — insertion-order substring scan maps `"sister-in-law"→Sibling`, `"son-in-law"→Child`, `"mother-in-law"→Parent` (all should be `Relative`); it's the deterministic **rule** tier (bypasses the LLM confidence gate) → wrong relationship into the EC record. **fail-loud** (treat `"…-in-law"` as unmapped)
- ✅ `domain/operation-status.ts:26-28` — all-members-terminal → `"done"` even when **every** member `"failed"`; the coordinator chip reads "Done" on a 100%-failed fan-out. Deliberate + tested (per-member detail in `StatusCounts`). **keep** — **verify-live** the counts badge is prominent enough.
- ✅ `dashboard/hooks/usePostAction.ts:50` + `useWorkflowActionDispatcher.ts:209-213` — malformed 2xx body → `{}` → treated as "success, 0 errors"; bulk delete-all / retry-all / tree-cancel purge every targeted row though the real per-item outcome is unknown. **fail-loud**
- `dashboard/ocr/OcrReviewPane.tsx:622,706,753` — approve proceeds with no check on `data.failedPages`; a partially-failed OCR run reads as fully handled and dropped pages never reach the operator. **fail-loud**
- `dashboard/hooks/useRosters.ts` (via `resource-factory.ts:186`) → `RunModal.tsx:246-266` — a failed `/api/rosters` fetch and a genuinely-empty dir both resolve to `[]`, so a transient failure silently flips the run to "download a fresh roster". **verify-live**
- `dashboard/log-panel/LogPanel.tsx:285-287` — a historical run with missing `activeRun.data` silently reverts the detail grid to the live run's `entry` (+ stale `typedData`) → wrong person's fields (the documented past bug, reproduced). **fail-loud**
- `dashboard/navigation/SearchBar.tsx:45-58` — non-2xx/network error → `[]`, identical to a zero-hit search → operator concludes a subject was never processed and re-runs an irreversible transaction. **fail-loud** ("search failed" state)
- ✅ `tracker/find-latest-entry.ts:21-34` (`parseDataJson`) — `catch → {}` (no log) backs `emitInheritedRow`'s prior-row reconstruction; a parse failure produces a prior entry with no archetype/traceId/metadata (the ISS-006 lineage-sever class). **fail-loud / log.warn**
- ✅ `tracker/state/queries/statements.ts:5-12` (`parseJsonObject`) — canonical `catch → fallback {}` with no logging (unlike its siblings), reused by entries/runs/run-events/prior-entries; corrupted `data_json` silently loses `data.archetype` → renders as a plain `single` row. **fail-loud / log.warn**

---

## MEDIUM (condensed)

Grouped by area; each is a wrong/misleading outcome under a narrower trigger. Full detail in the agent findings.

- **systems:** `ucpath/selectors.ts:930-934` & `:1663-1668` (generic `.first()` name selectors) · `ucpath/person-org-summary.ts:63-99` (body-scan name heuristic) · `ucpath/personal-data.ts:82-94` (`readExistingContactNames catch → []` → duplicate contact) · `ucpath/ss-smart-hr.ts:475-554` (`findExistingHireTransaction` broad `catch → none`, fail-open by design) · `kuali/navigate.ts:505` (existing-comments read `catch → ""` overwrites prior comments) · `kuali/navigate.ts:85-89` (Action List timeout → "empty" → skips real pending docs) · `kuali/navigate.ts:213-224` (`isVoluntaryTermination` — new type → "voluntary") · `old-kronos/reports.ts:478-498` + `navigate.ts:190-192` (no readback on Actual/Adjusted, output format, date typed) · `i9/search.ts:126-132,171` · `i9/create.ts:60-65` · `i9/login.ts:119-137` · `common/safe.ts:97-119` (`clickIfPresent` swallows frame-detached — audit its load-bearing call sites).
- **workflows:** `person-lookup/workflow.ts:234-255` (`matchCrmEid` ±7-day first cross-match) · `emergency-contact/config.ts:82-86` (`mapRelationship → "Other"`) · `onboarding/extract.ts:63-66` (appointment `?? value` keeps raw label) · `emergency-contact/enter.ts:215-226` (contact saved with zero phones) · `work-study/enter.ts:222-230` (no pre-submit duplicate probe) · `oath-upload/fill-form.ts:33-74` (Select2 Enter-to-accept, no readback) · `old-kronos-reports/validate.ts:15-32` (I/O error === "no data" → deletes a valid report) · `old-kronos-reports/validate.ts:38-80` (`"" === ""` name match defeats the cross-worker guard) · `ocr/orchestrator.ts:1514-1519` (carry-forward v1 parse fail → `[]` loses prior human corrections).
- **core:** `task-store/terminal.ts:139-142` · `task-store/claim.ts:62-66` (phantom claim) · `kernel/session.ts:745-752` (`reset` no-op when no `resetUrl` → residual cross-person state) · `daemon/daemon.ts:506-515` (`claimNextItem catch → null` = "queue empty") · `run-registry.ts:295-299` (`origin ?? 'user'`) · `kernel/workflow.ts:108` (2-letter code collision) · `kernel/ctx.ts:213-238` (`captureAndStampScreenshot` wrong-system fallback) · `daemon/shutdown.ts:475-485` & `in-flight-shutdown.ts:211-269` & `in-process-control.ts` (`swallowSqliteErr`) · `pool-core.ts` (`betweenItems` ignored in pool mode).
- **dashboard:** `OcrReviewPane.tsx:1023` (`lookup-failed` treated as approve-eligible) · `RunModal.tsx:285` (per-file duplicate check `?? []`) · `useRunsForMergedEntry.ts:85-93` · `RunSelector.tsx:89` · `NotificationBell.tsx:209-219` · `TerminalDrawer.tsx:75-86` & `WorkflowBox.tsx:515` (missing `health` counts as healthy) · `workflows-context.tsx:106-114` (malformed workflow def → guessed label) · `FailedPageCard.tsx` (Skip is local-only, no-op).
- **tracker:** `tracker/tasks/store.ts:788-797` & `delegation/watch-child-runs.ts:353-366` & `scheduler.ts:283-296` (`parseStringRecord catch → {}`, unlogged) · `tracker/tasks/store.ts:28-45` (unknown `control_state → "queued"`) · `tracker/session-events.ts:174-181` (malformed JSONL line dropped, no warn).

---

## LOW / keep(justified)

Retry-of-same-op paths, cosmetic display defaults, and documented fail-open tradeoffs where the real backstop is elsewhere. Notable "keep but tighten": `common/safe.ts` `clickIfPresent` (audit call sites), `resource-factory.ts` polled-resource stale-serve (add max-staleness), `ss-smart-hr.ts findExistingHireTransaction` (narrow the catch to expected types). Full list in the agent findings.

---

## Recommended fix order

1. **Trivial fail-loud conversions (do first — one-liners, no live check needed):** C2 `parsePayRate`, C6 `employeeSigned` default, C12/`fan-out.ts` itemId, C11 partial-cancel, C9/C-cluster malformed-2xx handlers, C1/H `transaction.ts` timeout→success, the `catch { won = true }` pair, `separations mapReasonCode("")`, `onboarding "5"` default, the tracker `parseJsonObject` loggers.
2. **Identity guards (fail-loud, small):** C3 new-kronos probe, C4 old-kronos name mismatch, C13/C14 person-lookup ambiguous/CRM-first, C16 `"SDCMP"`, C5 onbase count.
3. **Approval-gate fixes (dashboard):** C8 dependency poll, C10 preview gate, `failedPages` check.
4. **Save-verification (need a live page to confirm the confirmation marker):** C15 emergency-contact save, oath-signature save, work-study identity check — `verify-live` then fail-loud.
5. **Duplicate-run guards (core/control, need care):** supersede/cancel/heartbeat/roster-path.

Each fix should either throw with a message naming the offending value, or propagate a distinguishable "unknown" the caller checks — never let "the check failed" read as "the check passed."
