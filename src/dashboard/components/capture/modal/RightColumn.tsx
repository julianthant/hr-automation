import { cn } from "@/lib/utils";
import type { CaptureSessionInfo, CaptureState, CaptureValidation } from "../capture-types.js";
import { CapturePhotoTile } from "../CapturePhotoTile.js";
import type { StartedSession } from "./index.js";
import { ActionRow } from "./ActionRow.js";
import { ValidationBanner } from "./ValidationBanner.js";
import { isTerminal } from "./capture-state-terminal.js";

const photoSrc = (sessionId: string, index: number) =>
  `/api/capture/photos/${encodeURIComponent(sessionId)}/${index}`;

export interface RightColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  info: CaptureSessionInfo | null;
  validation: CaptureValidation | null;
  arrivedIndex: number | null;
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  /** When false, validation renders outside (modal grid row below). */
  showValidation?: boolean;
  onPhotoView: (photoIndex: number) => void;
  onPhotoDelete: (photoIndex: number) => void;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
  className?: string;
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
  showValidation = true,
  onPhotoView,
  onPhotoDelete,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onCloseAndStartNew,
  className,
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

  return (
    <div className={cn("flex min-h-0 flex-col gap-[22px]", className)}>
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

      {showValidation && (
        <ValidationBanner
          validation={validation}
          blurFlaggedCount={blurFlaggedCount}
          photoCount={photos.length}
          active={state === "open"}
        />
      )}
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
