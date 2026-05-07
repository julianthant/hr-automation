import { cn } from "@/lib/utils";

/**
 * Connection-state pill. Green dot + "Live" when SSE is connected to the
 * dashboard backend; red dot + "Live" (in destructive tone) on disconnect.
 *
 * Mounted in the TerminalDrawer bar at the right edge — the operator's
 * eye finds it before the clock when scanning the bottom of the screen
 * for "is the dashboard still receiving updates?".
 */
export function LiveIndicator({ connected }: { connected: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium leading-none flex-shrink-0",
        connected
          ? "bg-[#4ade80]/8 border border-[#4ade80]/20 text-[#4ade80]"
          : "bg-destructive/8 border border-destructive/20 text-destructive",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "w-[6px] h-[6px] rounded-full",
          connected ? "bg-[#4ade80] animate-pulse" : "bg-destructive",
        )}
      />
      Live
    </div>
  );
}
