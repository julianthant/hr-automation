import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleSlash, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  MetaLine,
  RadioGroup,
  Refusal,
  Textarea,
  Well,
  dsIcon,
  dsText,
  useToasts,
} from "./demo-ui";
import { fmtClock, fmtElapsed, type ActionDescriptorWire } from "./demo-wire";
import type { DemoRow } from "./demo-data";
import type { DemoActionHandler } from "./DemoActions";
import { hasRefusalCode, type DemoCommandResult, type DemoCommandSettling } from "./demo-commands";
import { fenceCleared, fenceClearsAt, writeFenceFor } from "./demo-flows-wire";

/**
 * DEV-ONLY — the two typed exits from `Write parked` (row-model D20, doc 09
 * §4.1), finished.
 *
 * `Write parked` means one thing: a write was attempted and we cannot tell
 * whether it landed. There is no Resume and no Retry — resuming an unknown
 * write is how a person gets terminated twice. There are exactly two answers,
 * and both are the operator reporting what they SAW:
 *
 *  - **Confirmed present** — with PROOF, parsed by the same schema the run's
 *    own completion would have used, plus an operator-attestation arm for the
 *    case where the confirmation page cannot be shown.
 *  - **Confirmed absent** — with a written evidence note, and only after the
 *    settle fence: one look is an observation, not authority.
 *
 * Both bind the DOUBLE FENCE: the same subject key and the same intent
 * generation as the parked write. Fail either and the server refuses outright —
 * the refusal is a `danger` toast, which never auto-dismisses, because "nothing
 * was recorded" is exactly the message an operator must not miss.
 */

type Arm = "present" | "absent";

const OBSERVATION_OPTIONS = [
  {
    value: "one" as const,
    label: "Once, just now",
    description: "Recorded as one qualifying observation. The write stays parked while a second probe settles it.",
  },
  {
    value: "two-spaced" as const,
    label: "Twice, at least 10 minutes apart",
    description: "Two independent reads that agree. This settles the absence and unlocks retry.",
  },
  {
    value: "two-adjacent" as const,
    label: "Twice, back to back",
    description: "Two reads in the same minute — the fence does not accept these as independent.",
  },
];

export interface ParkResolveState {
  row: DemoRow;
  action: ActionDescriptorWire;
}

export function isParkResolution(action: ActionDescriptorWire): boolean {
  return action.command === "resolve-write-present" || action.command === "resolve-write-absent";
}

export function ParkResolveDialog({
  pending,
  onClose,
  onAction,
  onSettling,
  tick,
}: {
  pending: ParkResolveState | null;
  onClose: () => void;
  onAction: DemoActionHandler;
  onSettling: (settling: DemoCommandSettling) => void;
  tick: number;
}) {
  const { toast } = useToasts();
  const row = pending?.row;
  const action = pending?.action;
  const arm: Arm = action?.command === "resolve-write-present" ? "present" : "absent";
  const fence = useMemo(() => (row ? writeFenceFor(row) : null), [row]);

  const [proofSource, setProofSource] = useState<"page" | "attestation">("page");
  const [transactionNumber, setTransactionNumber] = useState("");
  const [attestation, setAttestation] = useState("");
  const [observedEid, setObservedEid] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [observations, setObservations] = useState<"one" | "two-spaced" | "two-adjacent">("one");
  const [refusal, setRefusal] = useState<DemoCommandResult | null>(null);

  // A fresh open starts a fresh answer — but never mid-flight: the operator's
  // typing survives a refusal, which is the whole point of the refusal.
  useEffect(() => {
    if (!pending) return;
    setRefusal(null);
    setObservedEid("");
    setTransactionNumber("");
    setAttestation("");
    setEvidenceNote("");
    setObservations("one");
    setProofSource("page");
  }, [pending]);

  if (!pending || !row || !action || !fence) return null;

  const cleared = fenceCleared(fence, tick);

  const submit = () => {
    const payload: Record<string, string> = {
      intentGeneration: String(fence.intentGeneration),
      observedEid,
      ...(arm === "present"
        ? { proofSource, transactionNumber, attestation }
        : { evidenceNote, observations }),
    };
    const result = onAction(row, { ...action, confirm: undefined, payload });
    if (!result) return;
    if (result.state === "applied") {
      if (result.settling) {
        onSettling(result.settling);
        toast({
          tone: "warning",
          title: "Observation recorded — still parked",
          description: `${result.settling.observations} of ${result.settling.required} qualifying observations. Retry stays locked until the probe at ${fmtClock(result.settling.nextProbeAt)} agrees.`,
        });
      } else {
        toast({
          tone: arm === "present" ? "success" : "info",
          title: result.headline,
          description: result.detail,
        });
      }
      onClose();
      return;
    }
    // Refused. Keep the dialog, keep every value the operator typed, and say
    // in as many words that nothing was recorded.
    setRefusal(result);
    toast({
      tone: "danger",
      title: result.headline,
      description: `${result.detail} (code ${result.code})`,
    });
  };

  const canSubmit =
    observedEid.length > 0 &&
    (arm === "present"
      ? proofSource === "page"
        ? transactionNumber.trim().length > 0
        : attestation.trim().length > 0
      : evidenceNote.trim().length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={arm === "present" ? "Record the write as PRESENT" : "Record the write as ABSENT"}
        description={
          arm === "present"
            ? `You found the ${row.workflow.label.toLowerCase()} in ${fence.system}. Give the proof you read, and it will be parsed the way the run itself would have parsed it.`
            : `You looked in ${fence.system} and found nothing. An absence unlocks a REAL second submit, so it has to clear the fence before it counts.`
        }
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
          <FenceFacts row={row} tick={tick} />

          {refusal &&
            (hasRefusalCode(refusal) ? (
              <Refusal
                title={refusal.headline}
                code={refusal.code}
                outcome="nothing was recorded · your answer below is untouched"
              >
                {refusal.detail}
              </Refusal>
            ) : (
              <Banner tone="danger" title={refusal.headline}>
                {refusal.detail} Nothing was recorded and your answer below is untouched — but the server sent no
                refusal code, so there is nothing here to quote in a bug report.
              </Banner>
            ))}

          <div className="flex flex-col gap-[var(--ds-space-tight)]">
            <RadioGroup
              label={`Which ${fence.system} record did you open?`}
              name="park-observed-eid"
              value={observedEid}
              onValueChange={setObservedEid}
              options={fence.candidates.map((c) => ({ value: c.eid, label: `EID ${c.eid}`, description: c.label }))}
            />
            <FieldNote
              error={refusal?.code === "subject-key-mismatch" ? "This is not the subject the parked write is keyed to — nothing was recorded." : null}
              note="The fence checks that the record you looked at is the one this write is keyed to. A same-name neighbour cannot answer for this person."
            />
          </div>

          {arm === "present" ? (
            <>
              <RadioGroup
                label="What is your proof?"
                name="park-proof-source"
                value={proofSource}
                onValueChange={setProofSource}
                options={[
                  {
                    value: "page",
                    label: "I read the confirmation on the page",
                    description: `A ${fence.proofLabel} — e.g. ${fence.proofExample}.`,
                  },
                  {
                    value: "attestation",
                    label: "The page could not be shown — my attestation",
                    description: "The schema's operator-attestation arm. It is proof of the same weight, signed by you.",
                  },
                ]}
              />
              {proofSource === "page" ? (
                <Field
                  label={fence.proofLabel}
                  description={`Parsed by the run's own proof schema. Format: ${fence.proofExample}.`}
                  error={refusal?.code === "proof-parse-failed" ? "This did not parse as a transaction number — nothing was recorded." : null}
                  required
                >
                  <Input
                    value={transactionNumber}
                    onChange={(e) => setTransactionNumber(e.target.value)}
                    placeholder={fence.proofExample}
                    spellCheck={false}
                  />
                </Field>
              ) : (
                <Field
                  label="Attestation"
                  description="Say what you saw and where: the page, the person, the effective date. This replaces a machine-read confirmation, so it carries the same weight."
                  error={refusal?.code === "proof-parse-failed" ? "Too thin to stand as evidence — nothing was recorded." : null}
                  required
                >
                  <Textarea
                    rows={3}
                    value={attestation}
                    onChange={(e) => setAttestation(e.target.value)}
                    placeholder="Opened Job Data for EID 10577201; the 07/18/2026 voluntary termination is listed as processed, effective 07/18/2026."
                  />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field
                label="What did you check, and what did you see?"
                description="The only record of why a retry was permitted to submit for real."
                error={refusal?.code === "evidence-note-required" ? "Write what you checked — an empty note is not evidence." : null}
                required
              >
                <Textarea
                  rows={3}
                  value={evidenceNote}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                  placeholder="Job Data and Person Org Summary for EID 10577201 — no termination row of any effective date; last action is the 2024 hire."
                />
              </Field>
              <div className="flex flex-col gap-[var(--ds-space-tight)]">
                <RadioGroup
                  label="How many times did you look?"
                  name="park-observations"
                  value={observations}
                  onValueChange={setObservations}
                  options={OBSERVATION_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                    description:
                      o.value === "two-spaced" && !cleared
                        ? `${o.description} Not yet available — the fence clears at ${fmtClock(fenceClearsAt(fence))}.`
                        : o.description,
                  }))}
                />
                <FieldNote
                  error={
                    refusal?.code === "observations-not-independent" || refusal?.code === "absence-not-settled"
                      ? "The fence did not accept this — nothing was recorded."
                      : null
                  }
                  note={`Two independent observations at least ${fence.minBetweenReadsMin} minutes apart settle an absence. One look is an observation, not authority.`}
                />
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Not yet
          </Button>
          <Button
            variant={arm === "present" ? "primary" : "danger"}
            disabled={!canSubmit}
            icon={arm === "present" ? <CheckCircle2 aria-hidden className={dsIcon.md} /> : <CircleSlash aria-hidden className={dsIcon.md} />}
            onClick={submit}
          >
            {arm === "present" ? "I saw it — record present" : "I looked — record absent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The description/error line for a control group that is not a single input
 * (a radio set), where `Field`'s single-control aria wiring does not apply.
 * An error REPLACES the note, so there is never a choice about which to believe.
 */
function FieldNote({ error, note }: { error?: string | null; note: string }) {
  if (error) {
    return (
      <p role="alert" className={cn(dsText.meta, "text-[color:var(--ds-danger)]")}>
        {error}
      </p>
    );
  }
  return <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{note}</p>;
}

/** the served facts a resolution binds to — shown, not assumed */
function FenceFacts({ row, tick }: { row: DemoRow; tick: number }) {
  const fence = writeFenceFor(row);
  if (!fence) return null;
  const cleared = fenceCleared(fence, tick);
  return (
    <Well className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
      <Chip label="subject">{`${fence.subjectName} · ${fence.subjectEid}`}</Chip>
      <Chip label="fenced">{fmtClock(fence.fencedAt)}</Chip>
      <Chip label="generation">{String(fence.intentGeneration)}</Chip>
      <Chip label="fence clears" tone={cleared ? "neutral" : "warning"}>
        {`${fmtClock(fenceClearsAt(fence))}${cleared ? " · cleared" : " · not yet"}`}
      </Chip>
    </Well>
  );
}

/**
 * Requeue-while-settling. The row is neither finished nor failed: an absence
 * observation was accepted and the system put the row back into work to earn
 * the second one. Showing it as anything terminal would be a lie in the one
 * place a lie is most expensive.
 */
export function SettlingPanel({ settling, tick }: { settling: DemoCommandSettling; tick: number }) {
  // How long the row has been settling, driven by the shell's heartbeat — the
  // same tick every other elapsed value in the demo is derived from.
  const waited = fmtElapsed(tick);
  return (
    <Banner
      tone="info"
      title={`Still parked — settling ${settling.observations} of ${settling.required} observations`}
      icon={<Loader2 aria-hidden className={cn(dsIcon.lg, "animate-spin motion-reduce:animate-none")} />}
    >
      <span className="block">
        Your observation was recorded. The row is back in work: a second, independent probe is queued for{" "}
        <span className={dsText.nums}>{fmtClock(settling.nextProbeAt)}</span> and retry stays locked until the two agree.
        Nothing may submit in the meantime.
      </span>
      <MetaLine
        className="mt-[var(--ds-space-tight)] block"
        items={[
          `fence cleared ${fmtClock(settling.fenceClearedAt)}`,
          `waiting ${waited}`,
          `not_before ${settling.nextProbeAt.slice(11, 19)}`,
        ]}
      />
    </Banner>
  );
}
