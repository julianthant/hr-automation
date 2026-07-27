import { useState } from "react";
import { Check, ChevronDown, CircleAlert, CircleSlash, Download, Link2, Package, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  KeyValueList,
  SectionLabel,
  Table,
  TBody,
  TD,
  TH,
  THead,
  MetaLine,
  TR,
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
} from "./demo-ui";
import { fmtClock } from "./demo-wire";
import type { DemoRow } from "./demo-data";
import { downloadDemoFile } from "./DemoEvidence";
import { exportBundleJson, failureFor, type DemoFailureRecord } from "./demo-evidence-wire";

/**
 * DEV-ONLY — the full `FailureRecord` (doc 12 §2.1) and its diagnostic bundle
 * (§2.2), pinned above the Log Panel's tabs.
 *
 * A failed run raises exactly three questions, and they are answered in this
 * order because that is the order they matter in:
 *
 *  1. **What is half-done?** The most dangerous state in this product is a run
 *     that wrote something and stopped. `writeState` answers it in one line,
 *     before anything has to be expanded.
 *  2. **What is safe to retry?** Every remediation carries its own safety
 *     verdict — including the BLOCKED ones, listed with their reason, because
 *     "why can I not just retry this" is a question a hidden button never
 *     answers.
 *  3. **Why did it fail?** Classification, the progress ledger, the cause chain,
 *     the fingerprint's history, and the bundle to attach to a bug report.
 *
 * D13: when a `linked` child failed, the child's error is mirrored here
 * VERBATIM, so this row never says "unknown error" about a failure somebody
 * else already explained.
 */

const SAFETY_COPY = {
  safe: { word: "safe", tone: "success" as const },
  "needs-input": { word: "needs a fix first", tone: "warning" as const },
  blocked: { word: "blocked", tone: "danger" as const },
};

const PROGRESS_COPY = {
  done: { word: "done", cls: "text-[color:var(--ds-success-fg)]" },
  failed: { word: "FAILED HERE", cls: "text-[color:var(--ds-danger)]" },
  "never-ran": { word: "never ran", cls: "text-[color:var(--ds-fg-muted)]" },
};

function BundleDialog({ failure, onClose }: { failure: DemoFailureRecord; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={`Diagnostic bundle ${failure.bundle.bundleId}`}
        description={`Captured ${fmtClock(failure.bundle.capturedAt)} · ${failure.bundle.sizeLabel} · content-addressed, redacted at capture time`}
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
          <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
            One bounded package, taken automatically the moment this failed. It is what `explain run --bundle` writes, and it is
            what a bug report should carry instead of a pasted screenshot.
          </p>
          <div className="flex flex-col gap-[var(--ds-space-snug)]">
            {failure.bundle.contents.map((c) => (
              <div key={c.key} className="flex items-baseline gap-[var(--ds-space-base)]">
                <Check aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0 text-[color:var(--ds-success-fg)]")} />
                <span className={cn(dsText.body, "w-64 shrink-0 text-[color:var(--ds-fg)]")}>{c.key}</span>
                <span className={cn(dsText.meta, "min-w-0 flex-1 text-[color:var(--ds-fg-muted)]")}>{c.detail}</span>
              </div>
            ))}
          </div>
          <Banner tone="info" title="Redacted at capture, never at render">
            {failure.bundle.redactions.join(" · ")} — removed when the bundle was written, so there is no copy of them to leak
            later.
          </Banner>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            icon={<Download aria-hidden className={dsIcon.md} />}
            onClick={() => downloadDemoFile(`${failure.bundle.bundleId}.json`, exportBundleJson(failure), "application/json")}
          >
            Download the manifest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The failure record, pinned above the tabs so it is visible from every one of
 * them. Collapsed it answers the only question that cannot wait — **what is
 * half-done** — and expanded it carries the classification, the progress ledger,
 * what is safe to retry, the mirrored child error (D13) and the bundle.
 */
export function FailureRecordBlock({
  failure,
  open,
  onOpen,
  onOpenRow,
}: {
  failure: DemoFailureRecord;
  open: boolean;
  onOpen: (open: boolean) => void;
  onOpenRow: (rowId: string) => void;
}) {
  const [bundle, setBundle] = useState(false);
  const writeTone =
    failure.writeState.tone === "none"
      ? "text-[color:var(--ds-success-fg)]"
      : failure.writeState.tone === "unknown"
        ? "text-[color:var(--ds-status-parked-fg)]"
        : "text-[color:var(--ds-status-waiting-fg)]";

  return (
    <div className="border-b border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
        <TriangleAlert aria-hidden className={cn(dsIcon.md, "shrink-0 text-[color:var(--ds-danger)]")} />
        <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-danger)]")}>{failure.summary}</span>
        <Chip label="code" tone="danger">
          {failure.code}
        </Chip>
        <Chip label="" tone={failure.transient ? "warning" : "neutral"}>
          {failure.transient ? "transient — a later attempt may differ" : "permanent — the same input will fail again"}
        </Chip>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpen(!open)}
          data-demo-failure-toggle=""
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] border px-[var(--ds-space-base)]",
            "h-[var(--ds-h-sm)] rounded-[var(--ds-radius-md)] border-[color:var(--ds-danger-border)]",
            dsText.meta,
            dsFocus,
            "font-semibold text-[color:var(--ds-danger)]",
          )}
        >
          {open ? "Hide the full record" : "Open the full failure record"}
          <ChevronDown aria-hidden className={cn(dsIcon.sm, dsMotion.fast, open && "rotate-180")} />
        </button>
      </div>

      {/* the one line that cannot wait for an expand */}
      <p className={cn("mt-[var(--ds-space-tight)] pl-[var(--ds-space-loose)]", dsText.body, writeTone)}>
        {failure.writeState.text}
      </p>

      {open && (
        <div className="mt-[var(--ds-space-base)] flex flex-col gap-[var(--ds-space-cozy)] pl-[var(--ds-space-loose)]">
          {failure.mirrored && (
            <Banner
              tone="danger"
              title={`Mirrored from the delegated ${failure.mirrored.childWorkflow} run — this run did not fail on its own`}
              action={
                <Button
                  variant="secondary"
                  icon={<Link2 aria-hidden className={dsIcon.md} />}
                  onClick={() => onOpenRow(failure.mirrored!.childRowId)}
                >
                  Open the child run
                </Button>
              }
            >
              <span className="block">{failure.mirrored.verbatim}</span>
              <span className="mt-[var(--ds-space-tight)] block">
                <MetaLine items={[`child ${failure.mirrored.childTrace}`]} />
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                  {" "}
                  — quoted verbatim, so this row never says “unknown error” about a failure someone else already
                  explained (D13)
                </span>
              </span>
            </Banner>
          )}

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>What had already happened when it failed</SectionLabel>
            <div className="overflow-x-auto rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border)]">
              <Table label="Progress at the moment of failure">
                <THead>
                  <TR>
                    <TH>Step</TH>
                    <TH>State</TH>
                    <TH>System</TH>
                    <TH>What it left behind</TH>
                  </TR>
                </THead>
                <TBody>
                  {failure.progress.map((p) => (
                    <TR key={p.step}>
                      <TD className="text-[color:var(--ds-fg)]">{p.step}</TD>
                      <TD className={PROGRESS_COPY[p.state].cls}>{PROGRESS_COPY[p.state].word}</TD>
                      <TD>{p.system?.toUpperCase() ?? "—"}</TD>
                      <TD>{p.left ?? "nothing"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </section>

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>What is safe to retry</SectionLabel>
            <div className="flex flex-col gap-[var(--ds-space-snug)]">
              {failure.remediation.map((r) => {
                const safety = SAFETY_COPY[r.safety];
                const Icon = r.safety === "safe" ? Check : r.safety === "blocked" ? CircleSlash : CircleAlert;
                return (
                  <div key={r.key} className="flex items-start gap-[var(--ds-space-base)]">
                    <Icon
                      aria-hidden
                      className={cn(
                        dsIcon.md,
                        "mt-px shrink-0",
                        safety.tone === "success"
                          ? "text-[color:var(--ds-success-fg)]"
                          : safety.tone === "danger"
                            ? "text-[color:var(--ds-danger)]"
                            : "text-[color:var(--ds-status-waiting-fg)]",
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
                      <span className={cn(dsText.body, "font-medium text-[color:var(--ds-fg)]")}>
                        {r.label} — <span className={dsText.nums}>{safety.word}</span>
                      </span>
                      <span className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{r.detail}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Classification</SectionLabel>
            <KeyValueList
              items={[
                { key: "Fingerprint", value: failure.fingerprint },
                { key: "Code", value: failure.code },
                { key: "Occurred", value: fmtClock(failure.occurredAt) },
                { key: "Run", value: `${failure.traceId} · attempt ${failure.attempt}` },
                ...(failure.nodeId ? [{ key: "Node", value: failure.nodeId }] : []),
                ...(failure.taskId ? [{ key: "Task", value: failure.taskId }] : []),
                ...(failure.subject?.expected ? [{ key: "Subject expected", value: failure.subject.expected }] : []),
                ...(failure.subject?.observed
                  ? [{ key: "Subject observed", value: failure.subject.observed, tone: "danger" as const }]
                  : []),
                ...(failure.page?.screen ? [{ key: "Screen", value: failure.page.screen }] : []),
                ...(failure.page?.state ? [{ key: "Page state", value: failure.page.state }] : []),
                ...(failure.page?.urlRedacted ? [{ key: "URL (redacted)", value: failure.page.urlRedacted }] : []),
                ...(failure.action?.elementId
                  ? [
                      {
                        key: "Failed action",
                        value: `${failure.action.operation ?? "action"} on ${failure.action.elementId}${
                          failure.action.sequence ? ` · step ${failure.action.sequence}` : ""
                        }`,
                      },
                    ]
                  : []),
              ]}
            />
            {failure.subject?.note && (
              <p className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{failure.subject.note}</p>
            )}
          </section>

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Cause chain</SectionLabel>
            <ol className="flex flex-col gap-[var(--ds-space-tight)]">
              {failure.causeChain.map((c, i) => (
                <li key={`${c.layer}-${i}`} className="flex items-baseline gap-[var(--ds-space-base)]">
                  <span className={cn(dsText.caps, "w-14 shrink-0 text-[color:var(--ds-fg-muted)]")}>{c.layer}</span>
                  <span className={cn(dsText.body, "min-w-0 flex-1 text-[color:var(--ds-fg-secondary)]")}>
                    {c.text}
                    {c.at && <span className={cn(dsText.meta, dsText.nums, " text-[color:var(--ds-fg-muted)]")}> · {fmtClock(c.at)}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
            <Button variant="secondary" icon={<Package aria-hidden className={dsIcon.md} />} onClick={() => setBundle(true)}>
              Diagnostic bundle {failure.bundle.bundleId}
            </Button>
            {failure.seenBefore ? (
              <span className={cn(dsText.meta, "min-w-0 flex-1 text-[color:var(--ds-fg-secondary)]")}>
                <span className="font-semibold text-[color:var(--ds-status-waiting-fg)]">
                  Seen {failure.seenBefore.count}× in {failure.seenBefore.window}
                </span>{" "}
                — last {failure.seenBefore.lastTrace} at {fmtClock(failure.seenBefore.lastAt)}. {failure.seenBefore.note}
              </span>
            ) : (
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                First time this fingerprint has been seen.
              </span>
            )}
          </div>

          {failure.ownerRowId && failure.ownerRowId !== failure.rowId && (
            <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              This failure happened on a member row, not on this one.
            </span>
          )}
        </div>
      )}

      {bundle && <BundleDialog failure={failure} onClose={() => setBundle(false)} />}
    </div>
  );
}

/**
 * The row's failure record, if one is served. Exported so the Log Panel asks
 * this question instead of reaching into the evidence store itself.
 */
export function failureRecordFor(row: DemoRow): DemoFailureRecord | null {
  return failureFor(row);
}
