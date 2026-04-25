import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DaemonLogTailProps {
  pid: number;
  onClose: () => void;
}

/**
 * Streams /events/daemon-log?pid=X via EventSource. ~200px tall in-place
 * expansion under a DaemonRow. Mono font, scroll-snap to bottom, copy button.
 * Color cues: error/fail lines render destructive, [Step:] lines primary,
 * everything else muted-foreground that brightens on hover.
 */
export function DaemonLogTail({ pid, onClose }: DaemonLogTailProps) {
  const [lines, setLines] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource(`/events/daemon-log?pid=${pid}`);
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { line: string };
        if (parsed.line) {
          setLines((prev) => {
            // Cap at 500 lines to bound memory; daemon logs can be chatty.
            const next = [...prev, parsed.line];
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        }
      } catch {
        /* skip malformed payload */
      }
    };
    source.onerror = () => {
      // Connection closed (daemon exited or network blip). Don't auto-
      // reconnect — close cleanly so the user can re-open if they want.
      source.close();
    };
    return () => source.close();
  }, [pid]);

  // Auto-scroll to bottom when new lines arrive (matches LogStream pattern).
  useLayoutEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length]);

  const onCopy = (): void => {
    void navigator.clipboard.writeText(lines.join("\n"));
  };

  const lineClass = (line: string): string => {
    if (/error|fail/i.test(line)) return "text-destructive";
    if (line.includes("[Step:") || line.includes("[Auth:")) return "text-primary";
    return "text-muted-foreground hover:text-foreground";
  };

  return (
    <div className="mt-1 rounded-md border border-border/60 bg-background overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          Daemon log · pid {pid}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Copy log"
            onClick={onCopy}
            className="h-5 w-5 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Close log tail"
            onClick={onClose}
            className="h-5 w-5 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="max-h-[200px] overflow-y-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground italic">Waiting for log lines…</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={cn("transition-colors", lineClass(line))}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
