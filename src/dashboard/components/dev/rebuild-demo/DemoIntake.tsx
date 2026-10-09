import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FileSpreadsheet, GitCompare, Play, Table2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  MetaLine,
  Refusal,
  SectionLabel,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Well,
  dsFg,
  dsIcon,
  dsText,
} from "./demo-ui";
import { DEMO_NOW, DEMO_WORKFLOWS, plural, startContractToken } from "./demo-wire";
import {
  INTAKE_FIELDS,
  PRIOR_MANIFESTS,
  SHEET_BY_ID,
  SOURCE_SHEETS,
  buildRerunDiff,
  detectColumns,
  findSavedMapping,
  headerFingerprint,
  loadSavedMapping,
  suggestBindings,
  validateIntake,
  type Binding,
  type DetectedColumn,
  type IntakeCorrection,
  type IntakeExclusion,
  type IntakePlanManifest,
  type RowReject,
  type SavedMappingLoad,
  type SourceSheet,
  type TargetField,
} from "./demo-data-intake";
import { deriveTypedPlan, submitDemoEnqueue, type DemoEnqueueResult } from "./demo-runstart-wire";
import { EnqueueResultBanner, StageRail, type StageSpec } from "./DemoRunStartKit";

/**
 * DEV-ONLY — the spreadsheet INTAKE pipeline (`docs/rebuild/06-data-intake-and-edit-data.md`).
 *
 * A sheet is not an input. It is a grid whose header row has to be chosen,
 * whose columns have to be BOUND by an operator, and whose every cell has to
 * be coerced and then either accepted or rejected BY NAME. This surface is
 * that whole path, and the reason it is long is the reason it exists: each
 * stage is a place a silent substitution could enter, and each one refuses.
 *
 * The stages, and the refusal each one owns:
 *
 *   1. **File** — a saved mapping is found by the fingerprint of the whole
 *      column set. A near-miss layout reuses nothing.
 *   2. **Header row** — the parser proposes with a confidence and a reason; the
 *      operator confirms. Nothing is sniffed into a binding.
 *   3. **Mapping** — fuzzy matches are SUGGESTIONS, never applied. A saved
 *      binding whose column is gone reverts LOUD; a binding that reuses a
 *      duplicated heading blocks Run until it is confirmed with samples on
 *      screen.
 *   4. **Validate** — a bad cell throws a legible reject naming row, column and
 *      value. It is never defaulted, never skipped, never counted as valid. A
 *      whole column that fails on every row is surfaced as a mis-map.
 *   5. **Manifest** — one immutable record of what was accepted, corrected,
 *      excluded and rejected, with exactly one disposition per source row.
 *      Zero valid rows is a BLOCK, not a quiet success.
 *   6. **Rerun diff** — comparing a plan with a prior intake of the same
 *      source, so replayed data is never labelled as newly observed.
 */

type Stage = "file" | "header" | "mapping" | "validate" | "manifest" | "rerun";

const STAGES: StageSpec[] = [
  { key: "file", label: "File" },
  { key: "header", label: "Header row" },
  { key: "mapping", label: "Mapping" },
  { key: "validate", label: "Validate" },
  { key: "manifest", label: "Manifest" },
  { key: "rerun", label: "Rerun diff" },
];

const STAGE_ORDER: Stage[] = ["file", "header", "mapping", "validate", "manifest", "rerun"];

interface FixState {
  sourceRow: number;
  targetFieldId: string;
  original: string;
  value: string;
}

interface ExcludeState {
  sourceRow: number;
  reason: string;
}

export function DemoIntakeDialog({
  open,
  initialSheetId,
  onOpenChange,
}: {
  open: boolean;
  initialSheetId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [sheetId, setSheetId] = useState<string | null>(initialSheetId);
  const [headerRow, setHeaderRow] = useState<number | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [savedLoad, setSavedLoad] = useState<SavedMappingLoad | null>(null);
  const [corrections, setCorrections] = useState<IntakeCorrection[]>([]);
  const [exclusions, setExclusions] = useState<IntakeExclusion[]>([]);
  const [stage, setStage] = useState<Stage>(initialSheetId ? "header" : "file");
  const [furthest, setFurthest] = useState<Stage>(initialSheetId ? "header" : "file");
  const [reviewed, setReviewed] = useState(false);
  const [confirmField, setConfirmField] = useState<string | null>(null);
  const [fix, setFix] = useState<FixState | null>(null);
  const [exclude, setExclude] = useState<ExcludeState | null>(null);
  const [result, setResult] = useState<DemoEnqueueResult | null>(null);

  const sheet = sheetId ? (SHEET_BY_ID.get(sheetId) ?? null) : null;
  const fields = useMemo<TargetField[]>(() => (sheet ? (INTAKE_FIELDS[sheet.workflow] ?? []) : []), [sheet]);
  const columns = useMemo<DetectedColumn[]>(
    () => (sheet && headerRow ? detectColumns(sheet, headerRow) : []),
    [sheet, headerRow],
  );

  useEffect(() => {
    if (!open || !initialSheetId) return;
    setSheetId(initialSheetId);
    setStage((current) => (current === "file" ? "header" : current));
    setFurthest((current) => (current === "file" ? "header" : current));
  }, [open, initialSheetId]);

  const goto = useCallback((next: Stage) => {
    setStage(next);
    setFurthest((prev) => (STAGE_ORDER.indexOf(next) > STAGE_ORDER.indexOf(prev) ? next : prev));
  }, []);

  const pickSheet = useCallback(
    (next: SourceSheet) => {
      setSheetId(next.id);
      setHeaderRow(null);
      setBindings([]);
      setSavedLoad(null);
      setCorrections([]);
      setExclusions([]);
      setReviewed(false);
      setResult(null);
      setStage("header");
      setFurthest("header");
    },
    [],
  );

  /**
   * Confirming the header row is what makes a saved mapping applicable — the
   * fingerprint is over the columns detected AT THIS ROW. A hit pre-loads the
   * bindings VISIBLY; a miss starts unbound with suggestions only.
   */
  const pickHeaderRow = useCallback(
    (row: number) => {
      if (!sheet) return;
      setHeaderRow(row);
      const detected = detectColumns(sheet, row);
      const saved = findSavedMapping(detected);
      if (saved) {
        const load = loadSavedMapping(saved, detected);
        setSavedLoad(load);
        setBindings(load.bindings);
      } else {
        setSavedLoad(null);
        setBindings([]);
      }
      setCorrections([]);
      setExclusions([]);
      setReviewed(false);
      goto("mapping");
    },
    [sheet, goto],
  );

  const validation = useMemo(() => {
    if (!sheet || !headerRow) return null;
    return validateIntake({ sheet, headerRow, fields, bindings, corrections, exclusions, createdAt: DEMO_NOW });
  }, [sheet, headerRow, fields, bindings, corrections, exclusions]);

  const setBinding = useCallback((targetFieldId: string, sourceColumnId: string, origin: Binding["origin"]) => {
    setBindings((prev) => {
      const rest = prev.filter((b) => b.targetFieldId !== targetFieldId);
      if (sourceColumnId === "") return rest;
      return [...rest, { targetFieldId, sourceColumnId, origin }];
    });
    setReviewed(false);
  }, []);

  const confirmDuplicate = useCallback((targetFieldId: string, sourceColumnId: string) => {
    setBindings((prev) =>
      prev.map((b) => (b.targetFieldId === targetFieldId ? { targetFieldId, sourceColumnId, origin: "manual" as const } : b)),
    );
    setConfirmField(null);
  }, []);

  const close = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) setResult(null);
    },
    [onOpenChange],
  );

  const startRun = useCallback(() => {
    if (!sheet || !validation) return;
    const plan = deriveTypedPlan(
      DEMO_WORKFLOWS[sheet.workflow],
      validation.manifest.validRows.map((row, index) => ({
        position: index + 1,
        raw: row.itemId,
        value: row.parsedInput.fullName ?? row.itemId,
        kind: "name" as const,
      })),
    );
    setResult(
      submitDemoEnqueue({
        workflow: sheet.workflow,
        expectedContract: startContractToken(DEMO_WORKFLOWS[sheet.workflow]),
        method: "typed",
        plan,
        policy: "reject-active",
        dryRun: false,
        instances: {},
        scopeLabel: `“${sheet.fileName}”`,
      }),
    );
  }, [sheet, validation]);

  const reachable = useMemo(() => {
    const limit = STAGE_ORDER.indexOf(furthest);
    return new Set(STAGE_ORDER.slice(0, limit + 1));
  }, [furthest]);

  const rejects = validation?.manifest.rejectedRows ?? [];
  const rejectedRowCount = validation?.manifest.totals.rejected ?? 0;
  const canContinueFromValidate = Boolean(validation && !validation.block && (rejectedRowCount === 0 || reviewed));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        size="xl"
        title="Spreadsheet intake"
        description="A sheet becomes N runs only after a header row, an operator-built column mapping, and a per-cell accept-or-reject on every row."
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-loose)]">
          <StageRail stages={STAGES} current={stage} reachable={reachable} onSelect={(key) => setStage(key as Stage)} />

          {result && <EnqueueResultBanner result={result} onDismiss={() => setResult(null)} />}

          {stage === "file" && <FileStage onPick={pickSheet} selectedId={sheetId} />}

          {stage === "header" && sheet && <HeaderStage sheet={sheet} headerRow={headerRow} onPick={pickHeaderRow} />}

          {stage === "mapping" && sheet && headerRow && (
            <MappingStage
              sheet={sheet}
              columns={columns}
              fields={fields}
              bindings={bindings}
              savedLoad={savedLoad}
              onBind={setBinding}
              onConfirmField={setConfirmField}
            />
          )}

          {stage === "validate" && validation && sheet && headerRow && (
            <ValidateStage
              manifest={validation.manifest}
              block={validation.block}
              misMapHints={validation.misMapHints}
              rejects={rejects}
              reviewed={reviewed}
              onReviewed={setReviewed}
              onRemap={() => setStage("mapping")}
              fix={fix}
              onFixStart={(reject) =>
                setFix({
                  sourceRow: reject.sourceRow,
                  targetFieldId: reject.targetFieldId ?? "",
                  original: reject.raw ?? "",
                  value: reject.raw ?? "",
                })
              }
              onFixChange={(value) => setFix((prev) => (prev ? { ...prev, value } : prev))}
              onFixCancel={() => setFix(null)}
              onFixSave={() => {
                if (!fix || !fix.targetFieldId) return;
                setCorrections((prev) => [
                  ...prev.filter((c) => !(c.sourceRow === fix.sourceRow && c.targetFieldId === fix.targetFieldId)),
                  { sourceRow: fix.sourceRow, targetFieldId: fix.targetFieldId, original: fix.original, correctedValue: fix.value, correctedAt: DEMO_NOW },
                ]);
                setFix(null);
                setReviewed(false);
              }}
              exclude={exclude}
              onExcludeStart={(sourceRow) => setExclude({ sourceRow, reason: "" })}
              onExcludeChange={(reason) => setExclude((prev) => (prev ? { ...prev, reason } : prev))}
              onExcludeCancel={() => setExclude(null)}
              onExcludeSave={() => {
                if (!exclude || exclude.reason.trim() === "") return;
                setExclusions((prev) => [...prev, { sourceRow: exclude.sourceRow, reason: exclude.reason.trim(), operatorConfirmedAt: DEMO_NOW }]);
                setExclude(null);
                setReviewed(false);
              }}
            />
          )}

          {stage === "manifest" && validation && <ManifestStage manifest={validation.manifest} block={validation.block} />}

          {stage === "rerun" && validation && sheet && <RerunStage manifest={validation.manifest} sheetId={sheet.id} />}

          {/* Nested INSIDE the outer content on purpose: Radix stacks dismissable
              layers by React tree position, so a confirm rendered as a sibling of
              the outer content reads as an outside-click and takes the whole
              intake down with it. */}
          <DuplicateHeaderDialog
            open={confirmField !== null}
            field={fields.find((f) => f.id === confirmField) ?? null}
            columns={columns}
            bindings={bindings}
            onCancel={() => setConfirmField(null)}
            onConfirm={confirmDuplicate}
          />
        </DialogBody>

        <DialogFooter
          meta={
            sheet && (
              <MetaLine
                tone="faint"
                items={[
                  sheet.fileName,
                  headerRow && `header row ${headerRow}`,
                  headerRow && `fingerprint ${headerFingerprint(columns).slice(0, 8)}`,
                ]}
              />
            )
          }
        >
          {stage !== "file" && (
            <Button
              variant="ghost"
              icon={<ArrowLeft aria-hidden className={dsIcon.md} />}
              onClick={() => setStage(STAGE_ORDER[Math.max(0, STAGE_ORDER.indexOf(stage) - 1)])}
            >
              Back
            </Button>
          )}
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          {stage === "mapping" && (
            <Button variant="primary" onClick={() => goto("validate")} disabled={bindings.length === 0}>
              Validate {validation ? plural(validation.manifest.totals.sourceRows, "row") : "rows"}
            </Button>
          )}
          {stage === "validate" && (
            <Button variant="primary" disabled={!canContinueFromValidate} onClick={() => goto("manifest")}>
              Review the plan
            </Button>
          )}
          {stage === "manifest" && (
            <>
              <Button variant="outline" icon={<GitCompare aria-hidden className={dsIcon.md} />} onClick={() => goto("rerun")}>
                Compare with a prior intake
              </Button>
              <Button
                variant="primary"
                icon={<Play aria-hidden className={dsIcon.md} />}
                disabled={Boolean(validation?.block) || result?.state === "applied"}
                onClick={startRun}
              >
                Start {plural(validation?.manifest.totals.valid ?? 0, "run")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 1. File
// ---------------------------------------------------------------------------

function FileStage({ onPick, selectedId }: { onPick: (sheet: SourceSheet) => void; selectedId: string | null }) {
  return (
    <section className="flex flex-col gap-[var(--ds-space-snug)]">
      <SectionLabel>Source file</SectionLabel>
      <ul className="flex flex-col gap-[var(--ds-space-snug)]">
        {SOURCE_SHEETS.map((sheet) => (
          <li key={sheet.id}>
            <Card
              interactive
              selected={sheet.id === selectedId}
              role="button"
              tabIndex={0}
              aria-pressed={sheet.id === selectedId}
              onClick={() => onPick(sheet)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(sheet);
                }
              }}
              className="flex-row items-center gap-[var(--ds-space-base)] p-[var(--ds-space-base)]"
            >
              <FileSpreadsheet aria-hidden className={cn(dsIcon.lg, "shrink-0", dsFg.muted)} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn(dsText.ui, "truncate", dsFg.base)}>{sheet.fileName}</span>
                <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>
                  {sheet.sizeLabel} · {plural(sheet.grid.length, "row")} read · sha {sheet.sha256.slice(0, 8)}
                </span>
              </span>
              <Chip label="target">{DEMO_WORKFLOWS[sheet.workflow].label}</Chip>
              {sheet.savedMappingHint && <Badge tone="info">mapping {sheet.savedMappingHint}</Badge>}
            </Card>
          </li>
        ))}
      </ul>
      <Well>
        <span className={dsFg.secondary}>
          The parser returns detected columns and a few sample values per column — never the whole file to this surface. Row values are
          read again, server-side, at validation.
        </span>
      </Well>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. Header row
// ---------------------------------------------------------------------------

function HeaderStage({ sheet, headerRow, onPick }: { sheet: SourceSheet; headerRow: number | null; onPick: (row: number) => void }) {
  const [choice, setChoice] = useState(headerRow ?? sheet.suggestedHeaderRow);
  return (
    <section className="flex flex-col gap-[var(--ds-space-cozy)]">
      <Banner tone="info" title={`The parser proposes row ${sheet.suggestedHeaderRow}`}>
        A proposal, with its reasoning — not a decision. Every downstream binding is keyed to the row you confirm here, so a wrong
        header row would silently bind every field to the wrong column.
      </Banner>

      <ul className="flex flex-col gap-[var(--ds-space-snug)]">
        {sheet.headerCandidates.map((candidate) => (
          <li key={candidate.row}>
            <Card
              interactive
              selected={candidate.row === choice}
              role="button"
              tabIndex={0}
              aria-pressed={candidate.row === choice}
              onClick={() => setChoice(candidate.row)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setChoice(candidate.row);
                }
              }}
              className="gap-[var(--ds-space-tight)] p-[var(--ds-space-base)]"
            >
              <span className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
                <Chip label="row">{String(candidate.row)}</Chip>
                <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>confidence {candidate.confidence.toFixed(2)}</span>
                <span className={cn(dsText.body, dsFg.secondary)}>{candidate.why}</span>
              </span>
              <span className={cn(dsText.body, dsText.nums, "truncate", dsFg.base)}>
                {(sheet.grid[candidate.row - 1] ?? []).filter(Boolean).join(" · ") || "(empty row)"}
              </span>
            </Card>
          </li>
        ))}
      </ul>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Table2 aria-hidden className={dsIcon.md} />} onClick={() => onPick(choice)}>
          Use row {choice} as the header
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3. Mapping grid
// ---------------------------------------------------------------------------

function columnLabel(column: DetectedColumn): string {
  return column.duplicated ? `${column.header} (#${column.occurrence})` : column.header;
}

function MappingStage({
  sheet,
  columns,
  fields,
  bindings,
  savedLoad,
  onBind,
  onConfirmField,
}: {
  sheet: SourceSheet;
  columns: DetectedColumn[];
  fields: TargetField[];
  bindings: Binding[];
  savedLoad: SavedMappingLoad | null;
  onBind: (targetFieldId: string, sourceColumnId: string, origin: Binding["origin"]) => void;
  onConfirmField: (targetFieldId: string) => void;
}) {
  const suggestions = useMemo(() => suggestBindings(columns, fields), [columns, fields]);
  const bindingByField = new Map(bindings.map((b) => [b.targetFieldId, b]));
  const columnById = new Map(columns.map((c) => [c.sourceColumnId, c]));
  const pendingConfirmations = bindings.filter((b) => b.confirmationRequired).length;

  return (
    <section className="flex flex-col gap-[var(--ds-space-cozy)]">
      {savedLoad ? (
        <Banner tone="info" title={`Saved mapping loaded — ${savedLoad.mapping.id}, saved ${savedLoad.mapping.savedAt.slice(0, 10)}`}>
          The bindings below were pre-loaded because this file's column fingerprint matches one you have mapped before. They are shown,
          not applied silently — nothing runs until you look at them.
        </Banner>
      ) : (
        <Banner tone="info" title="New layout — nothing is pre-filled">
          No saved mapping matches this column fingerprint. Every field starts <strong>unbound</strong>; the suggestions below are
          proposals you accept, never guesses that are applied for you.
        </Banner>
      )}

      {savedLoad?.reverted.map((revert) => (
        <Banner key={revert.targetFieldId} tone="danger" title={`“${revert.targetFieldId}” reverted to unmapped`}>
          The saved mapping bound <strong>{revert.targetFieldId}</strong> to a column headed “{revert.wantedHeader}”, which this file
          does not have. It has been left unbound. The stored column position is deliberately not used as a fallback — a column
          inserted upstream would then map the wrong column, silently. {savedLoad.mapping.note}
        </Banner>
      ))}

      {/* Live, not historical: once the operator confirms a column the banner
          goes, or it would keep demanding something already done. */}
      {pendingConfirmations > 0 && (
        <Banner tone="warning" title={`${pendingConfirmations} reused binding needs confirming`}>
          More than one column in this file carries the same heading, so a saved binding to it is ambiguous — two identical headings
          are semantically unknowable. Confirm which column is meant, with its samples on screen, before anything runs.
        </Banner>
      )}

      <div className="overflow-x-auto">
        <Table label={`Column mapping for ${sheet.fileName}`}>
          <THead>
            <TR>
              <TH>Target field</TH>
              <TH>Source column</TH>
              <TH>Samples</TH>
              <TH>Suggestion</TH>
            </TR>
          </THead>
          <TBody>
            {fields.map((field) => {
              const binding = bindingByField.get(field.id);
              const bound = binding ? columnById.get(binding.sourceColumnId) : undefined;
              const suggestion = suggestions.find((s) => s.targetFieldId === field.id);
              const suggested = suggestion ? columnById.get(suggestion.sourceColumnId) : undefined;
              const needsConfirm = Boolean(binding?.confirmationRequired);
              return (
                <TR key={field.id}>
                  <TD>
                    <span className="flex flex-col">
                      <span className={cn(dsText.ui, dsFg.base)}>
                        {field.label}
                        {field.required && (
                          <span aria-hidden className={cn("ml-0.5", dsFg.danger)}>
                            *
                          </span>
                        )}
                      </span>
                      <span className={cn(dsText.meta, dsFg.muted)}>
                        {field.canonicalLabel} · {field.rule}
                      </span>
                    </span>
                  </TD>
                  <TD>
                    <span className="flex flex-col gap-[var(--ds-space-tight)]">
                      <Select
                        aria-label={`Source column for ${field.label}`}
                        value={binding?.sourceColumnId ?? ""}
                        onChange={(e) => onBind(field.id, e.target.value, "manual")}
                      >
                        <option value="">— unbound —</option>
                        {columns.map((column) => (
                          <option key={column.sourceColumnId} value={column.sourceColumnId}>
                            {columnLabel(column)}
                          </option>
                        ))}
                      </Select>
                      {binding && (
                        <span className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
                          <Chip label="from">{binding.origin}</Chip>
                          {needsConfirm && (
                            <Button size="sm" variant="outline" onClick={() => onConfirmField(field.id)}>
                              Confirm which column
                            </Button>
                          )}
                        </span>
                      )}
                    </span>
                  </TD>
                  <TD numeric className="max-w-[220px]">
                    <span className="block truncate">{(bound ?? suggested)?.samples.join(" · ") ?? "—"}</span>
                  </TD>
                  <TD>
                    {suggestion && suggested ? (
                      <span className="flex flex-col gap-[var(--ds-space-tight)]">
                        <span className={cn(dsText.meta, dsFg.muted)}>
                          {suggestion.why} ({suggestion.score.toFixed(2)})
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={binding?.sourceColumnId === suggestion.sourceColumnId}
                          onClick={() => onBind(field.id, suggestion.sourceColumnId, "suggestion")}
                        >
                          {binding?.sourceColumnId === suggestion.sourceColumnId ? "Accepted" : `Accept “${columnLabel(suggested)}”`}
                        </Button>
                      </span>
                    ) : (
                      <span className={cn(dsText.meta, dsFg.faint)}>no proposal</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </section>
  );
}

function DuplicateHeaderDialog({
  open,
  field,
  columns,
  bindings,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  field: TargetField | null;
  columns: DetectedColumn[];
  bindings: Binding[];
  onCancel: () => void;
  onConfirm: (targetFieldId: string, sourceColumnId: string) => void;
}) {
  if (!field) return null;
  const binding = bindings.find((b) => b.targetFieldId === field.id);
  const bound = columns.find((c) => c.sourceColumnId === binding?.sourceColumnId);
  const candidates = columns.filter((c) => c.normalizedHeader === bound?.normalizedHeader);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        size="md"
        title={`Which “${bound?.header}” column means ${field.label}?`}
        description="Two columns carry this heading. A saved binding cannot tell them apart, so it will not be reused until you say which one — with the values in front of you."
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-snug)]">
          {candidates.map((column) => (
            <Card key={column.sourceColumnId} className="gap-[var(--ds-space-tight)] p-[var(--ds-space-base)]">
              <span className="flex items-center gap-[var(--ds-space-base)]">
                <span className={cn(dsText.ui, dsFg.base)}>
                  {column.header} — occurrence {column.occurrence}
                </span>
                {column.sourceColumnId === binding?.sourceColumnId && <Badge tone="info">saved binding</Badge>}
              </span>
              <span className={cn(dsText.body, dsText.nums, dsFg.muted)}>{column.samples.join(" · ")}</span>
              <span className="flex justify-end">
                <Button size="sm" variant="primary" icon={<Check aria-hidden className={dsIcon.md} />} onClick={() => onConfirm(field.id, column.sourceColumnId)}>
                  Use this one
                </Button>
              </span>
            </Card>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 4. Validate — per-cell rejects, corrections, exclusions, the zero-valid block
// ---------------------------------------------------------------------------

function ValidateStage({
  manifest,
  block,
  misMapHints,
  rejects,
  reviewed,
  onReviewed,
  onRemap,
  fix,
  onFixStart,
  onFixChange,
  onFixCancel,
  onFixSave,
  exclude,
  onExcludeStart,
  onExcludeChange,
  onExcludeCancel,
  onExcludeSave,
}: {
  manifest: IntakePlanManifest;
  block: { code: string; message: string } | null;
  misMapHints: { targetFieldId: string; column: string; failed: number; total: number; message: string }[];
  rejects: RowReject[];
  reviewed: boolean;
  onReviewed: (next: boolean) => void;
  onRemap: () => void;
  fix: FixState | null;
  onFixStart: (reject: RowReject) => void;
  onFixChange: (value: string) => void;
  onFixCancel: () => void;
  onFixSave: () => void;
  exclude: ExcludeState | null;
  onExcludeStart: (sourceRow: number) => void;
  onExcludeChange: (reason: string) => void;
  onExcludeCancel: () => void;
  onExcludeSave: () => void;
}) {
  const totals = manifest.totals;
  return (
    <section className="flex flex-col gap-[var(--ds-space-cozy)]">
      <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
        <Chip label="rows">{String(totals.sourceRows)}</Chip>
        <Chip label="valid" tone={totals.valid > 0 ? "neutral" : "danger"}>
          {String(totals.valid)}
        </Chip>
        <Chip label="rejected" tone={totals.rejected > 0 ? "warning" : "neutral"}>
          {String(totals.rejected)}
        </Chip>
        <Chip label="excluded">{String(totals.excluded)}</Chip>
        <Chip label="corrected">{String(totals.corrected)}</Chip>
        <span className={cn(dsText.meta, dsFg.muted)}>
          {totals.rejectionEvents} rejection event{totals.rejectionEvents === 1 ? "" : "s"} recorded
        </span>
      </div>

      {block && (
        <Refusal
          title="This plan cannot start"
          code={block.code}
          outcome="nothing is enqueued"
          action={
            block.code === "no-valid-rows" ? undefined : (
              <Button size="sm" variant="secondary" onClick={onRemap}>
                Back to mapping
              </Button>
            )
          }
        >
          {block.message}
        </Refusal>
      )}

      {misMapHints.map((hint) => (
        <Banner
          key={hint.targetFieldId}
          tone="warning"
          title="This looks like the wrong column"
          action={
            <Button size="sm" variant="secondary" onClick={onRemap}>
              Re-map it
            </Button>
          }
        >
          {hint.message} Every row failing the same way is a mapping problem, not {hint.failed} data problems — fixing {hint.failed} cells
          would bake the mistake in.
        </Banner>
      ))}

      {rejects.length === 0 ? (
        <EmptyState
          title="No rejections"
          description="Every source row coerced and parsed cleanly against the bound fields. There is no list to review, so the plan is ready."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table label="Rejected rows">
              <THead>
                <TR>
                  <TH align="right">Row</TH>
                  <TH>Kind</TH>
                  <TH>Field / column</TH>
                  <TH>Why</TH>
                  <TH align="right">Resolve</TH>
                </TR>
              </THead>
              <TBody>
                {rejects.map((reject) => (
                  <TR key={reject.rejectId}>
                    <TD numeric align="right">
                      {reject.sourceRow}
                    </TD>
                    <TD>
                      <Badge tone={reject.kind === "duplicate-identity" || reject.kind === "cross-field" ? "warning" : "danger"}>{reject.kind}</Badge>
                    </TD>
                    <TD>
                      <span className="flex flex-col">
                        <span className={dsFg.base}>{reject.targetFieldId ?? reject.paths?.join(" + ") ?? "—"}</span>
                        {reject.column && <span className={cn(dsText.meta, dsFg.muted)}>“{reject.column.header}”</span>}
                        {reject.raw !== undefined && <span className={cn(dsText.meta, dsText.nums, dsFg.faint)}>raw: {reject.raw || "(empty)"}</span>}
                      </span>
                    </TD>
                    <TD className="max-w-[420px]">
                      <span className="block">{reject.reason}</span>
                      <span className={cn(dsText.meta, dsText.nums, dsFg.faint)}>code {reject.code}</span>
                    </TD>
                    <TD align="right">
                      <span className="flex justify-end gap-[var(--ds-space-tight)]">
                        {reject.targetFieldId && reject.raw !== undefined && (
                          <Button size="sm" variant="outline" onClick={() => onFixStart(reject)}>
                            Fix cell
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => onExcludeStart(reject.sourceRow)}>
                          Exclude…
                        </Button>
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          {fix && (
            <Card className="gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]">
              <span className={cn(dsText.ui, "font-semibold", dsFg.base)}>
                Correct row {fix.sourceRow} · {fix.targetFieldId}
              </span>
              <Field
                label="Corrected value"
                description="The source file is never rewritten. The correction is recorded in the manifest with the original beside it, and the value is re-coerced and re-parsed before it can become valid."
              >
                <Input value={fix.value} onChange={(e) => onFixChange(e.target.value)} />
              </Field>
              <span className="flex justify-end gap-[var(--ds-space-base)]">
                <Button variant="secondary" icon={<X aria-hidden className={dsIcon.md} />} onClick={onFixCancel}>
                  Cancel
                </Button>
                <Button variant="primary" icon={<Check aria-hidden className={dsIcon.md} />} disabled={fix.value.trim() === "" || fix.value === fix.original} onClick={onFixSave}>
                  Re-coerce this cell
                </Button>
              </span>
            </Card>
          )}

          {exclude && (
            <Card className="gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]">
              <span className={cn(dsText.ui, "font-semibold", dsFg.base)}>Exclude row {exclude.sourceRow}</span>
              <Field
                label="Reason"
                required
                error={exclude.reason.trim() === "" ? "An exclusion without a reason is a row that vanished. Say why." : null}
                description="Recorded in the manifest with a timestamp, so the receipt can never imply every source row ran."
              >
                <Input value={exclude.reason} placeholder="duplicate export line — already filed last week" onChange={(e) => onExcludeChange(e.target.value)} />
              </Field>
              <span className="flex justify-end gap-[var(--ds-space-base)]">
                <Button variant="secondary" icon={<X aria-hidden className={dsIcon.md} />} onClick={onExcludeCancel}>
                  Cancel
                </Button>
                <Button variant="primary" icon={<Check aria-hidden className={dsIcon.md} />} disabled={exclude.reason.trim() === ""} onClick={onExcludeSave}>
                  Exclude with this reason
                </Button>
              </span>
            </Card>
          )}

          <Checkbox
            checked={reviewed}
            onCheckedChange={(next) => onReviewed(next === true)}
            label={`I have read all ${totals.rejected} rejected row${totals.rejected === 1 ? "" : "s"}`}
            description="Nothing half-launches: the plan stays closed until every non-valid row has been corrected, excluded, or seen."
          />
        </>
      )}

      {manifest.corrections.length > 0 && (
        <Well className="flex flex-col gap-[var(--ds-space-tight)]">
          <SectionLabel>Corrections</SectionLabel>
          {manifest.corrections.map((correction) => (
            <span key={`${correction.sourceRow}-${correction.targetFieldId}`} className={cn(dsText.body, dsText.nums, dsFg.secondary)}>
              row {correction.sourceRow} · {correction.targetFieldId}: “{correction.original}” → “{correction.correctedValue}”
            </span>
          ))}
        </Well>
      )}

      {manifest.exclusions.length > 0 && (
        <Well className="flex flex-col gap-[var(--ds-space-tight)]">
          <SectionLabel>Exclusions</SectionLabel>
          {manifest.exclusions.map((exclusion) => (
            <span key={exclusion.sourceRow} className={cn(dsText.body, dsFg.secondary)}>
              <span className={dsText.nums}>row {exclusion.sourceRow}</span> — {exclusion.reason}
            </span>
          ))}
        </Well>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5. Manifest receipt
// ---------------------------------------------------------------------------

function ManifestStage({ manifest, block }: { manifest: IntakePlanManifest; block: { code: string; message: string } | null }) {
  return (
    <section className="flex flex-col gap-[var(--ds-space-cozy)]">
      {block ? (
        <Refusal title="This plan cannot start" code={block.code} outcome="nothing is enqueued">
          {block.message}
        </Refusal>
      ) : (
        <Banner tone="success" title={`${manifest.totals.valid} of ${manifest.totals.sourceRows} source rows will run`}>
          Every source row below has exactly one disposition. The counts are derived from those dispositions, never summed from the
          rejection history — a row that was rejected and then corrected is counted once, as valid.
        </Banner>
      )}

      <KeyValueList
        items={[
          { key: "plan id", value: manifest.planId },
          { key: "source", value: `${manifest.source.originalName} · sha ${manifest.source.sha256.slice(0, 12)}` },
          { key: "artifact", value: manifest.source.artifactId },
          { key: "mapping fingerprint", value: manifest.mappingFingerprint },
          { key: "mapping snapshot", value: manifest.mappingSnapshotHash },
          { key: "workflow contract", value: manifest.workflowContractFingerprint },
          { key: "created", value: manifest.createdAt },
          {
            key: "totals",
            value: `${plural(manifest.totals.sourceRows, "row")} · ${manifest.totals.valid} valid · ${manifest.totals.rejected} rejected · ${manifest.totals.excluded} excluded · ${manifest.totals.corrected} corrected`,
          },
        ]}
      />

      <div className="overflow-x-auto">
        <Table label="Source row dispositions">
          <THead>
            <TR>
              <TH align="right">Row</TH>
              <TH>Disposition</TH>
              <TH>Item</TH>
              <TH>Input hash</TH>
              <TH>Parsed input</TH>
            </TR>
          </THead>
          <TBody>
            {manifest.sourceRowDispositions.map((disposition) => {
              const valid = manifest.validRows.find((v) => v.sourceRow === disposition.sourceRow);
              return (
                <TR key={disposition.sourceRow}>
                  <TD numeric align="right">
                    {disposition.sourceRow}
                  </TD>
                  <TD>
                    <Badge tone={disposition.disposition === "valid" ? "success" : disposition.disposition === "excluded" ? "neutral" : "danger"}>
                      {disposition.disposition}
                    </Badge>
                  </TD>
                  <TD numeric>{disposition.itemId ?? "—"}</TD>
                  <TD numeric>{valid?.inputHash.slice(0, 10) ?? "—"}</TD>
                  <TD className="max-w-[320px]">
                    <span className="block truncate">
                      {valid
                        ? Object.entries(valid.parsedInput)
                            .map(([key, value]) => `${key}=${value}`)
                            .join(" · ")
                        : disposition.currentRejectIds.length > 0
                          ? `rejects: ${disposition.currentRejectIds.join(", ")}`
                          : "—"}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 6. Rerun diff
// ---------------------------------------------------------------------------

function RerunStage({ manifest, sheetId }: { manifest: IntakePlanManifest; sheetId: string }) {
  const prior = PRIOR_MANIFESTS.find((p) => p.sheetId === sheetId) ?? null;
  if (!prior) {
    return (
      <EmptyState
        title="No prior intake of this source"
        description="A rerun diff compares this plan with an earlier intake of the same file. This source has not been imported before, so there is nothing to compare it with — and nothing is invented to fill the gap."
      />
    );
  }
  const diff = buildRerunDiff(manifest, prior);
  return (
    <section className="flex flex-col gap-[var(--ds-space-cozy)]">
      <Banner tone={diff.contractChanged ? "warning" : "info"} title={`Compared with ${prior.planId}, made ${prior.createdAt.slice(0, 10)}`}>
        {diff.verdict}
      </Banner>

      <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
        <Chip label="unchanged">{String(diff.unchanged)}</Chip>
        <Chip label="added" tone={diff.added.length > 0 ? "info" : "neutral"}>
          {String(diff.added.length)}
        </Chip>
        <Chip label="removed" tone={diff.removed.length > 0 ? "warning" : "neutral"}>
          {String(diff.removed.length)}
        </Chip>
        <Chip label="mapping">{diff.mappingChanged ? "changed" : "identical"}</Chip>
        <Chip label="contract" tone={diff.contractChanged ? "warning" : "neutral"}>
          {diff.contractChanged ? "changed" : "identical"}
        </Chip>
      </div>

      <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[640px]:grid-cols-2">
        <Well className="flex flex-col gap-[var(--ds-space-tight)]">
          <SectionLabel>In this plan, not in {prior.planId}</SectionLabel>
          {diff.added.length === 0 ? (
            <span className={dsFg.faint}>nothing</span>
          ) : (
            diff.added.map((item) => (
              <span key={item.itemId} className={cn(dsText.body, dsFg.secondary)}>
                <span className={dsText.nums}>{item.itemId}</span> — {item.label}
              </span>
            ))
          )}
        </Well>
        <Well className="flex flex-col gap-[var(--ds-space-tight)]">
          <SectionLabel>In {prior.planId}, not here</SectionLabel>
          {diff.removed.length === 0 ? (
            <span className={dsFg.faint}>nothing</span>
          ) : (
            diff.removed.map((item) => (
              <span key={item.itemId} className={cn(dsText.body, dsFg.secondary)}>
                <span className={dsText.nums}>{item.itemId}</span> — {item.label}
              </span>
            ))
          )}
        </Well>
      </div>

      <Banner tone="info" title="Reruns never relabel replayed data as newly observed" icon={<TriangleAlert aria-hidden className={dsIcon.lg} />}>
        A rerun from this manifest re-uses the immutable source artifact and the exact validated input hashes. Anything it replays is
        marked as replayed on the receipt; only a value actually re-read from a system is recorded as observed.
      </Banner>
    </section>
  );
}
