import type { CaptureSessionInfo, CaptureState, CaptureValidation } from "../capture-types.js";
import { CapturePhotoTile } from "../CapturePhotoTile.js";
import type { StartedSession } from "./index.js";
import { ActionRow } from "./ActionRow.js";
import { ValidationBanner } from "./ValidationBanner.js";
import { isTerminal } from "./capture-state-terminal.js";

const photoSrc = (sessionId: string, index: number) =>
  `/api/capture/photos/${encodeURIComponent(sessionId)}/${index}`;

function describeStatus(state: CaptureState, phoneConnected: boolean, photoCount: number): string {
  if (state === "finalizing") return "Bundling photos for handoff…";
  if (state === "finalized") return "Sent to handler. Closing automatically…";
  if (state === "finalize_failed") return "Couldn't send to handler.";
  if (state === "expired") return "Session expired.";
  if (state === "discarded") return "Session discarded.";
  if (!phoneConnected) return "Waiting for phone to scan QR.";
  if (photoCount === 0) return "Phone connected — awaiting photos.";
  return `Phone connected — ${photoCount} photo${photoCount === 1 ? "" : "s"} received.`;
}

export interface RightColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  info: CaptureSessionInfo | null;
  validation: CaptureValidation | null;
  arrivedIndex: number | null;
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  onPhotoView: (photoIndex: number) => void;
  onPhotoDelete: (photoIndex: number) => void;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
}

export function RightColumn({
  state,
  started,
  info,
  validation,
  arrivedIndex,
  retrying,
  finalizeDisabled,
  photoCount,
  onPhotoView,
  onPhotoDelete,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onCloseAndStartNew,
}: RightColumnProps) {
  if (state === "starting" || state === "error") {
    return (
      <div className="flex items-center justify-center" style={{ color: "var(--capture-fg-faint)" }}>
        <span className="font-mono text-xs">—</span>
      </div>
    );
  }

  const photos = info?.photos ?? [];
  const blurFlaggedCount = photos.filter((p) => p.blurFlagged).length;
  const sessionTerminal = isTerminal(state);
  const phoneConnected = info?.phoneConnectedAt != null;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* STATUS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Status
        </div>
        <div
          className="flex items-center gap-2.5 py-1 text-[12px]"
          style={{ color: "var(--capture-fg-secondary)" }}
          aria-live="polite"
        >
          <span
            className="inline-block h-[5px] w-[5px] rounded-full shrink-0"
            style={{ backgroundColor: "var(--capture-fg-secondary)" }}
            aria-hidden
          />
          <span>{describeStatus(state, phoneConnected, photos.length)}</span>
        </div>
      </div>

      {/* PHOTOS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Live photos · <span className="font-mono tabular-nums" style={{ color: "var(--capture-fg-secondary)" }}>{photos.length}</span>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          {photos.map((p) => (
            <CapturePhotoTile
              key={`${p.index}-${p.uploadedAt}`}
              photo={p}
              imageSrc={started ? photoSrc(started.sessionId, p.index) : ""}
              onView={() => onPhotoView(p.index)}
              onDelete={sessionTerminal ? undefined : () => onPhotoDelete(p.index)}
              justArrived={p.index === arrivedIndex}
              disabled={sessionTerminal}
            />
          ))}
          {!sessionTerminal &&
            Array.from({ length: Math.max(0, 4 - photos.length) }).map((_, i) => (
              <PlaceholderTile key={`ph-${i}`} />
            ))}
        </div>
      </div>

      <ValidationBanner
        validation={validation}
        blurFlaggedCount={blurFlaggedCount}
        photoCount={photos.length}
        active={state === "open"}
      />

      <ActionRow
        state={state}
        retrying={retrying}
        finalizeDisabled={finalizeDisabled}
        photoCount={photoCount}
        onFinalize={onFinalize}
        onRetryHandoff={onRetryHandoff}
        onDiscard={onDiscard}
        onCloseAndStartNew={onCloseAndStartNew}
      />
    </div>
  );
}

function PlaceholderTile() {
  return (
    <div
      className="aspect-[3/4] rounded-md"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        background: "linear-gradient(135deg, var(--capture-bg-raised) 0%, var(--capture-bg-modal) 100%)",
      }}
      aria-hidden
    />
  );
}
