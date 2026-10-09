import { type ReactNode } from "react";
import { Check, CircleAlert, Fingerprint, ScanEye, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Chip,
  DS_STATUS,
  KeyValueList,
  MetaLine,
  SectionLabel,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Well,
  dsIcon,
  dsText,
} from "./demo-ui";
import { fmtClock } from "./demo-wire";
import type { DemoRow } from "./demo-data";
import { SystemTag } from "./DemoEvidence";
import {
  receiptFor,
  receiptInvariant,
  testInstanceSystems,
  type DemoActionEvidence,
  type DemoRunReceipt,
} from "./demo-evidence-wire";

/**
 * DEV-ONLY — the full `RunEvidenceReceipt` (doc 12 §2.3).
 *
 * The acceptance test this is built against (§6.6 Q8): **the operator can
 * double-check the run without opening UCPath.** So it leads with the identity
 * the system showed at the moment of the commit, then every write with its
 * confirmation number and the read-back that proved it, then the per-member
 * confirmations INLINE (D17), then the completion criteria — and only after all
 * of that, what was read, what was decided and where the values came from.
 *
 * Two rules it will not bend:
 *
 *  - **A write with no read-back says so in those words.** `unsupported` /
 *    `not-attempted` / `failed` each render their served reason. Silence would
 *    read as verification, which is the failure mode this whole rebuild exists
 *    to prevent.
 *  - **The verdict is checked, not trusted.** `receiptInvariant` re-applies doc
 *    12's rule at render time; a `verified-done` this evidence cannot justify is
 *    reported as a defect instead of printed as a result.
 */

/**
 * The receipt's verdict WORD, and where it comes from.
 *
 * Four of the five verdicts are the same verdict the row's chip renders, so
 * they read their word from `DS_STATUS` rather than restating it. That is the
 * whole point: a chip saying `Done` beside a receipt saying `Verified done` was
 * two names for one verdict, and the only reason it could happen is that the
 * word was typed twice. Now it is typed once — rename the status and the
 * receipt follows.
 *
 * **The GUARANTEE did not shorten with the word.** `verified-done` is still the
 * key, it is still only reachable through `deriveReceiptResult`, and
 * `receiptInvariant` still refuses to print it without verified confidence,
 * every criterion met and no unfinished member. The read-back column below is
 * what earns it.
 *
 * `partial` is the one verdict with no status of its own — a run can be
 * partially filed without the row being able to say so — so it carries its own
 * word here, deliberately.
 */
const RESULT_COPY: Record<DemoRunReceipt["result"], { word: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  "verified-done": { word: DS_STATUS.verifiedDone.label, tone: "success" },
  "done-with-warnings": { word: DS_STATUS.doneWarnings.label, tone: "warning" },
  partial: { word: "Partial outcome", tone: "warning" },
  failed: { word: DS_STATUS.failed.label, tone: "danger" },
  cancelled: { word: DS_STATUS.cancelled.label, tone: "neutral" },
};

const CONFIDENCE_COPY: Record<DemoRunReceipt["confidence"], string> = {
  verified: "read back from the system of record",
  partial: "some of it read back",
  unknown: "nothing was read back",
};

const READ_BACK_COPY = {
  verified: { word: "read back", tone: "success" as const, icon: Check },
  unsupported: { word: "NOT read back — the system cannot show it", tone: "warning" as const, icon: CircleAlert },
  "not-attempted": { word: "NOT read back — no check was made", tone: "warning" as const, icon: CircleAlert },
  failed: { word: "read-back FAILED — outcome unverified", tone: "danger" as const, icon: TriangleAlert },
};

function ReceiptSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[var(--ds-space-snug)]">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  );
}

function WriteAction({ action, instance }: { action: Extract<DemoActionEvidence, { kind: "commit" | "prepare" }>; instance?: "prod" | "test" }) {
  const rb = READ_BACK_COPY[action.readBack.state];
  const RbIcon = rb.icon;
  return (
    <Well className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
        <Badge tone={action.kind === "commit" ? "info" : "neutral"}>{action.kind === "commit" ? "commit" : "prepare"}</Badge>
        <span className={cn(dsText.ui, "min-w-0 truncate font-medium text-[color:var(--ds-fg)]")}>{action.target}</span>
        <SystemTag system={action.system} instance={instance} />
        <span className={cn("ml-auto", dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{fmtClock(action.at)}</span>
      </div>

      <div className="flex flex-col gap-[var(--ds-space-hair)]">
        {action.wrote.map((w) => (
          <div key={w.field} className="flex items-baseline gap-[var(--ds-space-base)]">
            <span className={cn(dsText.meta, "w-36 shrink-0 text-[color:var(--ds-fg-muted)]")}>{w.field}</span>
            <span className={cn(dsText.body, dsText.nums, "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]")}>{w.value}</span>
          </div>
        ))}
      </div>

      {action.confirmation ? (
        <div
          className={cn(
            "flex items-baseline gap-[var(--ds-space-base)] border px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
            "rounded-[var(--ds-radius-md)] border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]",
          )}
        >
          <span className={cn(dsText.caps, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{action.confirmation.label}</span>
          <span className={cn(dsText.ui, dsText.nums, "font-semibold text-[color:var(--ds-success-fg)]")}>
            {action.confirmation.value}
          </span>
        </div>
      ) : (
        <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          {action.system.toUpperCase()} issues no confirmation number for this operation — the read-back below is the proof.
        </p>
      )}

      <div
        className={cn(
          "flex items-start gap-[var(--ds-space-base)] border px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
          "rounded-[var(--ds-radius-md)]",
          rb.tone === "success"
            ? "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]"
            : rb.tone === "danger"
              ? "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]"
              : "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
        )}
      >
        <RbIcon
          aria-hidden
          className={cn(
            dsIcon.md,
            "mt-px shrink-0",
            rb.tone === "success"
              ? "text-[color:var(--ds-success-fg)]"
              : rb.tone === "danger"
                ? "text-[color:var(--ds-danger)]"
                : "text-[color:var(--ds-status-waiting-fg)]",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
          <span className={cn(dsText.body, "font-semibold text-[color:var(--ds-fg)]")}>
            {rb.word}
            {action.readBack.at ? ` · ${fmtClock(action.readBack.at)}` : ""}
          </span>
          <span className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
            {action.readBack.state === "verified" ? action.readBack.observed : action.readBack.note}
          </span>
        </div>
      </div>

      {action.detail && <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{action.detail}</p>}
    </Well>
  );
}

export function ReceiptView({ receipt, row }: { receipt: DemoRunReceipt; row: DemoRow }) {
  const verdict = RESULT_COPY[receipt.result];
  const invariant = receiptInvariant(receipt);
  const testSystems = testInstanceSystems(receipt);
  const writes = receipt.actions.filter(
    (a): a is Extract<DemoActionEvidence, { kind: "commit" | "prepare" }> => a.kind === "commit" || a.kind === "prepare",
  );
  const reads = receipt.actions.filter((a) => a.kind === "read" || a.kind === "local");

  return (
    <div className="flex flex-col gap-[var(--ds-space-loose)] p-[var(--ds-space-cozy)]">
      {/* the verdict, and the two things that qualify it */}
      <div
        className={cn(
          "flex flex-col gap-[var(--ds-space-snug)] border px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
          "rounded-[var(--ds-radius-lg)]",
          verdict.tone === "success"
            ? "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]"
            : verdict.tone === "warning"
              ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]"
              : verdict.tone === "danger"
                ? "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]"
                : "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)]",
        )}
      >
        <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
          <ShieldCheck
            aria-hidden
            className={cn(
              dsIcon.lg,
              verdict.tone === "success"
                ? "text-[color:var(--ds-success-fg)]"
                : verdict.tone === "danger"
                  ? "text-[color:var(--ds-danger)]"
                  : "text-[color:var(--ds-status-waiting-fg)]",
            )}
          />
          <span className={cn(dsText.section, "font-semibold text-[color:var(--ds-fg)]")}>{verdict.word}</span>
          <Chip label="confidence" tone={receipt.confidence === "verified" ? "neutral" : "warning"}>
            {`${receipt.confidence} — ${CONFIDENCE_COPY[receipt.confidence]}`}
          </Chip>
        </div>
        <MetaLine
          items={[
            `receipt ${receipt.receiptId}`,
            `generated ${fmtClock(receipt.generatedAt)}`,
            `attempt ${receipt.attempt}`,
            receipt.retryOf && `retry of ${receipt.retryOf}`,
            `filed by ${receipt.actor}`,
          ]}
        />
      </div>

      {invariant && (
        <Banner tone="danger" title="This receipt fails its own invariant — the verdict is not printed as fact">
          {invariant} doc 12 §2.3 forbids it, so the surface reports the defect instead of showing a green result.
        </Banner>
      )}

      {testSystems.length > 0 && (
        <Banner tone="warning" title={`Written to the TEST instance of ${testSystems.join(", ").toUpperCase()} — this is not a filing`}>
          Everything below really happened, on a test system. Nothing on this receipt changed a production record, and the
          confirmation numbers are test-instance numbers.
        </Banner>
      )}

      {row.dryRun && (
        <Banner tone="info" title="Dry run — this run was a rehearsal">
          A dry run reads everything and writes nothing. Any value below is an observation, never a change.
        </Banner>
      )}

      {/* Q8: who the system said the person was AT the commit */}
      {receipt.subjectAtCommit && (
        <ReceiptSection label="Who the system said this was, at the moment of the write">
          <Well className="flex flex-col gap-[var(--ds-space-snug)]">
            <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
              <ScanEye aria-hidden className={cn(dsIcon.md, "text-[color:var(--ds-fg-muted)]")} />
              <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{receipt.subjectAtCommit.name}</span>
              <Chip label="EID">{receipt.subjectAtCommit.eid}</Chip>
              <SystemTag system={receipt.subjectAtCommit.system} instance={receipt.resolvedInstance[receipt.subjectAtCommit.system]} />
              <span className={cn("ml-auto", dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
                {fmtClock(receipt.subjectAtCommit.observedAt)}
              </span>
            </div>
            <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{receipt.subjectAtCommit.proof}</p>
          </Well>
        </ReceiptSection>
      )}

      {writes.length > 0 && (
        <ReceiptSection label="What was written, and what proved it">
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            {writes.map((a) => (
              <WriteAction key={a.key} action={a} instance={receipt.resolvedInstance[a.system]} />
            ))}
          </div>
        </ReceiptSection>
      )}

      {/* D17 — per-member confirmation numbers INLINE, never one link per member */}
      {receipt.members && receipt.members.length > 0 && (
        <ReceiptSection label={`Per-person confirmations (${receipt.members.length})`}>
          <div className="overflow-x-auto rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border)]">
            <Table label="Per-person confirmation numbers">
              <THead>
                <TR>
                  <TH>Person</TH>
                  <TH>EID</TH>
                  <TH>Confirmation</TH>
                  <TH>Read back</TH>
                </TR>
              </THead>
              <TBody>
                {receipt.members.map((m) => (
                  <TR key={m.rowId}>
                    <TD className="text-[color:var(--ds-fg)]">{m.name}</TD>
                    <TD numeric>{m.eid ?? "—"}</TD>
                    <TD
                      numeric
                      className={m.confirmation ? "text-[color:var(--ds-fg)]" : "text-[color:var(--ds-danger)]"}
                    >
                      {m.confirmation ?? m.note ?? "none"}
                    </TD>
                    <TD>
                      {m.readBack === "verified" ? (
                        <span className={cn("inline-flex items-center gap-[var(--ds-space-hair)]", "text-[color:var(--ds-success-fg)]")}>
                          <Check aria-hidden className={dsIcon.sm} />
                          verified
                        </span>
                      ) : m.readBack === "failed" ? (
                        <span className={cn("inline-flex items-center gap-[var(--ds-space-hair)]", "text-[color:var(--ds-danger)]")}>
                          <X aria-hidden className={dsIcon.sm} />
                          none to read
                        </span>
                      ) : (
                        <span className="text-[color:var(--ds-status-waiting-fg)]">unverified</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            Listed here on purpose (D17): a link per person would turn one double-check into {receipt.members.length} of them.
          </p>
        </ReceiptSection>
      )}

      {receipt.verification.length > 0 && (
        <ReceiptSection label="Completion criteria">
          <div className="flex flex-col gap-[var(--ds-space-snug)]">
            {receipt.verification.map((v) => {
              const met = v.result === "met";
              const Icon = met ? Check : v.result === "unmet" ? X : CircleAlert;
              return (
                <div key={v.criterion} className="flex items-start gap-[var(--ds-space-base)]">
                  <Icon
                    aria-hidden
                    className={cn(
                      dsIcon.md,
                      "mt-px shrink-0",
                      met
                        ? "text-[color:var(--ds-success-fg)]"
                        : v.result === "unmet"
                          ? "text-[color:var(--ds-danger)]"
                          : "text-[color:var(--ds-status-waiting-fg)]",
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
                    <span className={cn(dsText.body, "font-medium text-[color:var(--ds-fg)]")}>
                      {v.criterion} — <span className={dsText.nums}>{v.result}</span>
                    </span>
                    <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                      {v.method}
                      {v.observed ? ` → ${v.observed}` : ""}
                      {v.at ? ` · ${fmtClock(v.at)}` : ""}
                    </span>
                    {v.note && <span className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{v.note}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </ReceiptSection>
      )}

      {(receipt.observations.length > 0 || reads.length > 0) && (
        <ReceiptSection label="What was read">
          {receipt.observations.length > 0 && (
            <div className="overflow-x-auto rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border)]">
              <Table label="Values observed during the run">
                <THead>
                  <TR>
                    <TH>Field</TH>
                    <TH>Value</TH>
                    <TH>System</TH>
                    <TH align="right">Observed</TH>
                  </TR>
                </THead>
                <TBody>
                  {receipt.observations.map((o) => (
                    <TR key={`${o.key}-${o.at ?? ""}`}>
                      <TD className="text-[color:var(--ds-fg)]">{o.key}</TD>
                      <TD numeric>{o.value}</TD>
                      <TD>{o.system?.toUpperCase() ?? "—"}</TD>
                      <TD align="right" numeric>
                        {o.at ?? "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          {reads.map((a) => (
            <div key={a.key} className="flex flex-wrap items-baseline gap-[var(--ds-space-snug)]">
              <Badge tone="neutral">{a.kind}</Badge>
              <span className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{a.target}</span>
              <SystemTag system={a.system} instance={receipt.resolvedInstance[a.system]} />
              <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{fmtClock(a.at)}</span>
              {"observed" in a && a.observed && (
                <span className={cn("w-full", dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{a.observed}</span>
              )}
              {a.detail && <span className={cn("w-full", dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{a.detail}</span>}
            </div>
          ))}
        </ReceiptSection>
      )}

      {receipt.decisions.length > 0 && (
        <ReceiptSection label="What was decided, and why">
          <div className="flex flex-col gap-[var(--ds-space-snug)]">
            {receipt.decisions.map((d) => (
              <div key={d.key} className="flex flex-col gap-[var(--ds-space-hair)]">
                <span className={cn(dsText.body, "font-medium text-[color:var(--ds-fg)]")}>
                  {d.key}: {d.outcome}
                  <span className={cn(dsText.meta, "ml-[var(--ds-space-snug)] font-normal text-[color:var(--ds-fg-muted)]")}>
                    {d.by === "operator" ? "decided by the operator" : "decided by rule"} · {fmtClock(d.at)}
                  </span>
                </span>
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{d.reason}</span>
              </div>
            ))}
          </div>
        </ReceiptSection>
      )}

      <ReceiptSection label="The input this run was given">
        <KeyValueList
          items={receipt.input.map((f) => ({
            key: f.key,
            value: f.redacted ? `${f.value} · redacted at capture` : f.value,
          }))}
        />
        <MetaLine items={[`input hash ${receipt.inputHash}`]} />
      </ReceiptSection>

      {receipt.reuse.length > 0 && (
        <ReceiptSection label="Fresh or replayed">
          {receipt.reuse.map((r) => (
            <div key={r.label} className="flex flex-col gap-[var(--ds-space-hair)]">
              <span className={cn(dsText.body, "font-medium text-[color:var(--ds-fg)]")}>
                <span className={dsText.nums}>{r.lane}</span> — {r.label}
                {r.age ? ` · ${r.age}` : ""}
              </span>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>{r.detail}</span>
            </div>
          ))}
        </ReceiptSection>
      )}

      {receipt.warnings.length > 0 && (
        <ReceiptSection label="What remains uncertain">
          <div className="flex flex-col gap-[var(--ds-space-snug)]">
            {receipt.warnings.map((w) => (
              <div key={w.key} className="flex items-start gap-[var(--ds-space-base)]">
                <CircleAlert aria-hidden className={cn(dsIcon.md, "mt-px shrink-0 text-[color:var(--ds-status-waiting-fg)]")} />
                <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
                  <span className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{w.text}</span>
                  <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                    {w.loadBearing
                      ? "load-bearing — this is why the run cannot read as done"
                      : "declared non-load-bearing — it cannot change the transaction or the core result"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </ReceiptSection>
      )}

      {receipt.note && (
        <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{receipt.note}</p>
      )}

      <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)] border-t border-[color:var(--ds-border-subtle)] pt-[var(--ds-space-base)]">
        <Fingerprint aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-faint)]")} />
        <Chip label="trace">{receipt.traceId}</Chip>
        <Chip label="descriptor">{receipt.descriptorFingerprint}</Chip>
        <Chip label="config">{receipt.configFingerprint}</Chip>
      </div>
    </div>
  );
}

/** the row's receipt, if one is served — the Log Panel asks this, not the store */
export function runReceiptFor(row: DemoRow): DemoRunReceipt | null {
  return receiptFor(row);
}
