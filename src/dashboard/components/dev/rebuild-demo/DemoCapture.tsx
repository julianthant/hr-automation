import { useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowDownToLine,
  Camera,
  CircleAlert,
  FileText,
  Hourglass,
  Info,
  Play,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  BulletList,
  CountBadge,
  EmptyState,
  IconButton,
  KeyValueList,
  MetaLine,
  SectionLabel,
  Select,
  Well,
  dsFg,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsText,
  useDsEnterTransition,
} from "./demo-ui";
import { fmtClock, fmtClockSec, plural } from "./demo-wire";
import {
  summarizeCaptureSession,
  type CapturePhotoFixture,
  type CaptureSessionFixture,
  type CaptureSessionPhase,
} from "./demo-runstart-wire";

/**
 * DEV-ONLY — the Run Modal's CAPTURE method: what the desktop is served about a
 * phone session, and every page that has landed on it.
 *
 * Three things are load-bearing:
 *
 *  - **The pages are on the RIGHT.** The left column is the session and its one
 *    decision; the right is the contact sheet, and it is the wider of the two.
 *    They are one grid with one gap and a divider that is a grid TRACK, so both
 *    columns end on the same line however much either has to say.
 *  - **Nothing here claims a page is good.** A captured page has been received,
 *    not read: there is no green, no check and no "accepted" anywhere on this
 *    surface. The only tone it spends is amber, on the page that cannot be
 *    read, because that is the one a human has to act on.
 *  - **No page is drawn.** The corpus carries a capture's metadata, not its
 *    bytes, and a stand-in of a real oath form on the surface an operator
 *    approves from is the exact fabrication the rebuild exists to stop. Each
 *    frame is the page's own SERVED shape and says it holds no image; the rule
 *    behind that lives once, in the ⓘ.
 */

// ---------------------------------------------------------------------------
// The session's state — four channels, and colour is never one of them alone
// ---------------------------------------------------------------------------

interface PhaseSpec {
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: "neutral" | "warning";
}

/**
 * `ready` is deliberately NEUTRAL. Green in this product means a write was read
 * back out of the system; a stack of photographs nobody has read yet has earned
 * none of that, and dressing it in the success hue would be the surface telling
 * the operator an outcome it does not have.
 */
const PHASE: Record<CaptureSessionPhase, PhaseSpec> = {
  "awaiting-phone": { label: "Waiting for the phone", Icon: Smartphone, tone: "neutral" },
  "awaiting-pages": { label: "Phone paired — no page yet", Icon: Hourglass, tone: "neutral" },
  receiving: { label: "Receiving pages", Icon: ArrowDownToLine, tone: "neutral" },
  blocked: { label: "A page cannot be read", Icon: CircleAlert, tone: "warning" },
  ready: { label: "Ready to finalise", Icon: Play, tone: "neutral" },
};

// ---------------------------------------------------------------------------
// One captured page
// ---------------------------------------------------------------------------

function PageTile({
  photo,
  current,
  onSelect,
}: {
  photo: CapturePhotoFixture;
  current: boolean;
  onSelect: () => void;
}) {
  const flagged = Boolean(photo.unreadable);
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      aria-label={`Page ${photo.page} — arrived ${fmtClockSec(photo.arrivedAt)}, ${photo.sizeLabel}, ${photo.width} by ${photo.height}${
        flagged ? ", flagged unreadable" : ""
      }`}
      onClick={onSelect}
      className={cn(
        // A tile is an OBJECT, so it reads the recessed plane as a matte fill
        // AND a hairline — the treatment every chip in the product wears.
        "flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-[var(--ds-space-hair)] border",
        "p-[var(--ds-space-tight)]",
        dsRadius.md,
        dsFocus,
        dsMotion.fast,
        "active:translate-y-px",
        flagged
          ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]"
          : "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)] hover:bg-[var(--ds-surface-3)]",
        // SELECTION NEVER TAKES THE FLAG'S EDGE. Which page you are reading is
        // a fill; which page cannot be read is an edge — so inspecting the
        // flagged page cannot quietly repaint the one cue that matters.
        current && "bg-[var(--ds-surface-selected)]",
        current && !flagged && "border-[color:var(--ds-border-loud)]",
      )}
    >
      {/* THE FRAME IS THE PAGE'S OWN SERVED SHAPE. Width comes from the grid
          track and the height falls out of the ratio, so a row of frames lands
          on one baseline without anyone picking a height — and a page that was
          shot at a different size would say so rather than be cropped to match
          its neighbours. */}
      <span
        aria-hidden
        style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
        className={cn(
          "flex w-full items-center justify-center border bg-[var(--ds-surface-1)]",
          dsRadius.sm,
          flagged ? "border-[color:var(--ds-status-waiting-mark)]" : "border-[color:var(--ds-border-subtle)]",
        )}
      >
        <FileText
          className={cn(
            dsIcon.md,
            flagged ? "text-[color:var(--ds-status-waiting-fg)]" : "text-[color:var(--ds-fg-faint)]",
          )}
        />
      </span>
      <span className={cn(dsText.micro, "truncate text-center font-medium", current ? dsFg.base : dsFg.secondary)}>
        Page {photo.page}
      </span>
      <span className={cn(dsText.micro, dsText.nums, "truncate text-center", dsFg.muted)}>
        {fmtClock(photo.arrivedAt)}
      </span>
      {/* The third line is always drawn, so every tile is the same height and
          the sheet keeps one baseline whether or not a page was flagged. */}
      <span
        className={cn(
          dsText.micro,
          "truncate text-center",
          // `muted`, not `faint`: a page's size is a fact the operator reads,
          // and `faint` is the disabled/placeholder step.
          flagged ? "text-[color:var(--ds-status-waiting-fg)]" : cn(dsText.nums, dsFg.muted),
        )}
      >
        {flagged ? "unreadable" : photo.sizeLabel}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function DemoCapturePanel({
  sessions,
  sessionId,
  onSessionId,
}: {
  /** every session the phone has open for the chosen workflow */
  sessions: CaptureSessionFixture[];
  sessionId: string;
  onSessionId: (next: string) => void;
}) {
  const [ruleOpen, setRuleOpen] = useState(false);
  /**
   * The inspected page, KEYED TO THE SESSION it belongs to. Holding a bare page
   * number would leave page 4 of one session selected after a switch, so the
   * facts on the left would be about a page the operator is not looking at.
   */
  const [picked, setPicked] = useState<{ sessionId: string; page: number } | null>(null);
  const enter = useDsEnterTransition();

  const session = sessions.find((s) => s.id === sessionId);

  if (!session) {
    return (
      <section aria-label="Capture session" className="flex flex-col gap-[var(--ds-space-snug)]">
        <SectionLabel>Capture session</SectionLabel>
        <Well>
          <EmptyState
            className="p-[var(--ds-space-base)]"
            icon={<Camera aria-hidden className={dsIcon.lg} />}
            title="No capture session is open"
            description="A capture starts on the phone. Until one is open there is nothing to build a plan from, and nothing here will invent one."
          />
        </Well>
      </section>
    );
  }

  const summary = summarizeCaptureSession(session);
  const phase = PHASE[summary.phase];
  const PhaseIcon = phase.Icon;
  const flagged = session.photos.filter((p) => p.unreadable);
  const currentPage =
    (picked?.sessionId === session.id ? picked.page : undefined) ?? session.photos[0]?.page;
  const inspected = session.photos.find((p) => p.page === currentPage);

  return (
    <section aria-label="Capture session" className="flex flex-col gap-[var(--ds-space-snug)]">
      {/* The header carries what is true of the whole section: what it is, which
          session it is about, and the one disclosure. Both columns below start
          at the same edge with a label of the same weight. */}
      <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
        <SectionLabel className="min-w-0 truncate">Capture session</SectionLabel>
        {sessions.length > 1 && (
          /* `lg`, not `md`: an option is `<id> · <state> · N pages` and a native
             select CUTS rather than wraps, so the width has to seat the longest
             state the vocabulary holds. */
          <span className="ml-auto min-w-0 max-w-[var(--ds-w-popover-lg)] flex-1">
            <Select
              aria-label="Open capture session"
              value={session.id}
              onChange={(e) => onSessionId(e.target.value)}
            >
              {sessions.map((s) => {
                const sum = summarizeCaptureSession(s);
                return (
                  <option key={s.id} value={s.id}>
                    {s.id} · {PHASE[sum.phase].label} · {sum.received} page{sum.received === 1 ? "" : "s"}
                  </option>
                );
              })}
            </Select>
          </span>
        )}
        <IconButton
          size="xs"
          className={sessions.length > 1 ? undefined : "ml-auto"}
          label="How this demo serves a capture"
          aria-expanded={ruleOpen}
          onClick={() => setRuleOpen((v) => !v)}
          icon={<Info aria-hidden className={dsIcon.sm} />}
        />
      </div>

      {/* An IN-PLACE disclosure, not a Popover: this panel lives inside a Dialog
          at z-40 and a Popover portals at z-20, so it would open behind the very
          dialog that contains it. */}
      {ruleOpen && (
        <div
          {...enter}
          className={cn(
            dsMotion.enter,
            "data-[demo-enter=from]:translate-y-[var(--ds-travel-sm)] data-[demo-enter=from]:opacity-0",
          )}
        >
          <Well>
            <BulletList
              items={[
                "The desktop is served the session and what has landed on it. It never reaches the phone, so nothing here can make a page arrive.",
                "Before OCR, this fixture serves each received page's geometry and file metadata. Extracted evidence uses a synthetic facsimile; this intake stage does not pretend the page has been read.",
                "Pages are numbered in the order the phone pushed them. Nothing has read them yet, so a page is a page and never a person.",
                "This demo runs no capture server, so the pairing code is a fixture rather than a QR code that scans to nothing.",
              ]}
            />
          </Well>
        </div>
      )}

      {/* ONE GRID, ONE GAP. The divider is a 1px TRACK, so it is exactly as tall
          as the taller column and the two columns end on the same line. The
          pages get the wider track because they are what the operator came to
          look at. */}
      <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-[minmax(0,1fr)_1px_minmax(0,1.55fr)]">
        {/* ---- LEFT: the session, its one hazard, and the inspected page ---- */}
        <div className="flex min-w-0 flex-col gap-[var(--ds-space-cozy)]">
          <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
            {/* `State`, not `Session` — the header a line above already said
                the word, and the count that used to sit here as a chip is the
                same number the sheet's own badge carries. A surface that says
                one fact twice teaches the eye to skip both. */}
            <SectionLabel>State</SectionLabel>
            <Well className="flex flex-col gap-[var(--ds-space-snug)]">
              <Badge tone={phase.tone} className="self-start">
                <PhaseIcon aria-hidden className={dsIcon.sm} />
                {phase.label}
              </Badge>
              <MetaLine
                items={[
                  session.id,
                  session.deviceLabel ?? `pairing code ${session.pairingCode}`,
                  `opened ${fmtClock(session.openedAt)}`,
                  session.connectedAt ? `paired ${fmtClock(session.connectedAt)}` : undefined,
                  summary.lastArrivedAt && session.stillUploading
                    ? `last page ${fmtClock(summary.lastArrivedAt)}`
                    : undefined,
                  `expires ${fmtClock(session.expiresAt)}`,
                ].filter((v): v is string => Boolean(v))}
              />
            </Well>
          </div>

          {flagged.length > 0 && (
            <Banner
              tone="warning"
              title={
                flagged.length === 1
                  ? `Page ${flagged[0].page} could not be read`
                  : `${plural(flagged.length, "page")} could not be read`
              }
            >
              {flagged.length === 1 ? (
                `${flagged[0].unreadable?.reason} Retake it on the phone — focus ${flagged[0].unreadable?.focusScore}.`
              ) : (
                <BulletList
                  items={flagged.map(
                    (p) => `Page ${p.page} — ${p.unreadable?.reason} Focus ${p.unreadable?.focusScore}.`,
                  )}
                />
              )}
            </Banner>
          )}

          {inspected && (
            <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>What was recorded</SectionLabel>
              <KeyValueList
                items={[
                  { key: "Page", value: `${inspected.page} of ${summary.received}` },
                  { key: "Arrived", value: fmtClockSec(inspected.arrivedAt) },
                  { key: "Pixels", value: `${inspected.width} × ${inspected.height}` },
                  { key: "Size", value: inspected.sizeLabel },
                  { key: "File", value: inspected.filename },
                  { key: "Type", value: inspected.mime },
                  ...(inspected.unreadable
                    ? [
                        {
                          key: "Read",
                          value: `flagged unreadable · focus ${inspected.unreadable.focusScore}`,
                          tone: "warning" as const,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          )}
        </div>

        {/* The divider is a grid TRACK, so it is exactly as tall as the taller
            column and needs no height of its own — it is also the thing that
            SAYS the two columns end level. It reads the strong hairline rather
            than the default one: at 8% white a structural divider between two
            filled columns is invisible, and an invisible divider is not one. */}
        <span aria-hidden className="hidden bg-[color:var(--ds-border-strong)] @min-[560px]:block" />

        {/* ---- RIGHT: the pages, which is what this method is about --------- */}
        <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
          <div className="flex items-center gap-[var(--ds-space-snug)]">
            <SectionLabel className="min-w-0 truncate">Pages received</SectionLabel>
            <CountBadge className="ml-auto" value={summary.received} />
          </div>
          {summary.received === 0 ? (
            /* `flex-1` on both branches: the sheet is the column's body, so it
               reaches the bottom edge whatever the LEFT column has to say. A
               box that stopped short would make the divider look like it was
               dividing nothing. */
            <Well className="flex min-h-0 flex-1 flex-col justify-center">
              <EmptyState
                className="p-[var(--ds-space-base)]"
                icon={<Camera aria-hidden className={dsIcon.lg} />}
                title="No page has arrived yet"
                description={
                  session.connectedAt
                    ? `The phone is paired and nothing has been photographed. Take the first page on ${session.deviceLabel ?? "the phone"}.`
                    : `The phone has not picked this session up. Enter ${session.pairingCode} on it to pair.`
                }
              />
            </Well>
          ) : (
            /* A well that SCROLLS draws its edge — the border is what tells the
               eye the sheet is cut rather than finished. `--ds-h-capture-box`
               is its ceiling, the same budget the evidence viewer gives a
               capture column, so a thirty-page packet never turns the modal
               into a page. */
            <Well className="min-h-0 flex-1 max-h-[var(--ds-h-capture-box)] overflow-y-auto">
              {/* NO STAGGER, deliberately. Pages arriving one at a time is the
                  one list in this product motion is allowed to carry — but it
                  is gated on the wire's OWN arrival instant, and a fixture's
                  pages are all already here when the panel mounts. Staggering
                  them would animate on first paint, which is the churn the
                  motion rules exist to prevent. */}
              <ul
                role="list"
                aria-label="Pages received"
                /* The track is a small CELL, not a hand-picked tile width: at
                   this density eight pages are one glance instead of a scroll,
                   and the sheet reflows to the column rather than to a
                   breakpoint. */
                className="grid gap-[var(--ds-space-snug)] [grid-template-columns:repeat(auto-fill,minmax(var(--ds-w-capacity-cell),1fr))]"
              >
                {session.photos.map((photo) => (
                  <li key={photo.page} className="min-w-0">
                    <PageTile
                      photo={photo}
                      current={photo.page === currentPage}
                      onSelect={() => setPicked({ sessionId: session.id, page: photo.page })}
                    />
                  </li>
                ))}
              </ul>
            </Well>
          )}
        </div>
      </div>
    </section>
  );
}
