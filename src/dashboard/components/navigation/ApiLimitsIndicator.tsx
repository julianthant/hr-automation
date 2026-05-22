import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

type KeyStateKind = "available" | "throttled" | "quota-exhausted" | "dead";

interface OcrKeyStatus {
  id: string;
  providerId: "gemini" | "mistral" | "groq" | "sambanova";
  state:
    | { kind: "available" }
    | { kind: "throttled"; untilMs: number }
    | { kind: "quota-exhausted"; untilMs: number }
    | { kind: "dead" };
  dailyCount?: number;
}

// ── Config ─────────────────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
  sambanova: "Sambanova",
};

const PROVIDER_ORDER = ["gemini", "mistral", "groq", "sambanova"];

const STATE_LABEL: Record<KeyStateKind, string> = {
  "available": "available",
  "throttled": "throttled",
  "quota-exhausted": "quota",
  "dead": "dead",
};

// ── Helpers ────────────────────────────────────────────────────────────────

type Health = "good" | "warn" | "critical" | "empty";

function overallHealth(statuses: OcrKeyStatus[]): Health {
  if (statuses.length === 0) return "empty";
  const kinds = statuses.map((s) => s.state.kind);
  if (kinds.every((k) => k === "dead" || k === "quota-exhausted")) return "critical";
  if (kinds.some((k) => k === "dead" || k === "quota-exhausted")) return "warn";
  if (kinds.some((k) => k === "throttled")) return "warn";
  return "good";
}

function formatUntilTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StateDot({ kind }: { kind: KeyStateKind }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-px",
        kind === "available" && "bg-emerald-400",
        kind === "throttled" && "bg-amber-400",
        kind === "quota-exhausted" && "bg-orange-500",
        kind === "dead" && "bg-destructive",
      )}
    />
  );
}

function StateChip({ state }: { state: OcrKeyStatus["state"] }) {
  const kind = state.kind;
  return (
    <span
      className={cn(
        "font-mono text-[10px] tabular-nums",
        kind === "available" && "text-emerald-400/80",
        kind === "throttled" && "text-amber-400",
        kind === "quota-exhausted" && "text-orange-500",
        kind === "dead" && "text-destructive",
      )}
    >
      {STATE_LABEL[kind]}
      {(kind === "throttled") && "untilMs" in state && (
        <span className="text-muted-foreground ml-1">
          ·&nbsp;until&nbsp;{formatUntilTime((state as { untilMs: number }).untilMs)}
        </span>
      )}
      {kind === "quota-exhausted" && (
        <span className="text-muted-foreground ml-1">·&nbsp;resets&nbsp;midnight</span>
      )}
    </span>
  );
}

function KeyRow({ status }: { status: OcrKeyStatus }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-[5px] hover:bg-accent/40 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <StateDot kind={status.state.kind} />
        <span className="font-mono text-[12px] text-foreground tracking-tight">
          {status.id}
        </span>
        <StateChip state={status.state} />
      </div>
      {status.dailyCount !== undefined && (
        <span className="font-mono text-[11px] text-muted-foreground/60 flex-shrink-0 tabular-nums">
          {status.dailyCount}&thinsp;req
        </span>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function ApiLimitsIndicator() {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<OcrKeyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatuses = (signal?: AbortSignal) => {
    fetch("/api/ocr/key-status", { signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: OcrKeyStatus[]) => {
        setStatuses(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchStatuses(controller.signal);
    intervalRef.current = setInterval(() => fetchStatuses(), 30_000);
    return () => {
      controller.abort();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const health = overallHealth(statuses);
  const geminiKeys = statuses.filter((s) => s.providerId === "gemini");
  const geminiAvail = geminiKeys.filter((s) => s.state.kind === "available").length;

  const byProvider: Record<string, OcrKeyStatus[]> = {};
  for (const s of statuses) (byProvider[s.providerId] ??= []).push(s);
  const sections = PROVIDER_ORDER.flatMap((p) => (byProvider[p]?.length ? [{ id: p, keys: byProvider[p] }] : []));

  const triggerLabel =
    geminiKeys.length > 0
      ? `G·${geminiAvail}/${geminiKeys.length}`
      : statuses.length > 0
        ? `AI·${statuses.length}`
        : "AI";

  const totalReqToday = statuses.reduce((s, k) => s + (k.dailyCount ?? 0), 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="OCR API key pool status"
          className={cn(
            "h-8 px-2.5 rounded-md border border-border bg-secondary",
            "flex items-center gap-1.5 cursor-pointer",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            "transition-colors",
          )}
        >
          {/* Health dot */}
          <span
            className={cn(
              "w-[5px] h-[5px] rounded-full flex-shrink-0 transition-colors",
              !loading && health === "good" && "bg-emerald-400",
              !loading && health === "warn" && "bg-amber-400",
              !loading && health === "critical" && "bg-destructive",
              (!loading && health === "empty") || loading ? "bg-muted-foreground/40" : "",
            )}
          />
          <span className="font-mono text-[11px] font-medium tabular-nums">
            {triggerLabel}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="p-0 w-[300px]">
        {/* Header */}
        <div className="px-3.5 pt-3 pb-2.5 border-b border-border flex items-start justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              OCR Key Pool
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
              {loading
                ? "Loading…"
                : statuses.length === 0
                  ? "No keys configured"
                  : `${statuses.length} key${statuses.length === 1 ? "" : "s"} · ${totalReqToday} req today · resets midnight UTC`}
            </div>
          </div>
          {/* Overall health pill */}
          {!loading && statuses.length > 0 && (
            <span
              className={cn(
                "text-[9px] font-mono font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded",
                health === "good" &&
                  "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20",
                health === "warn" &&
                  "bg-amber-400/10 text-amber-400 border border-amber-400/20",
                health === "critical" &&
                  "bg-destructive/10 text-destructive border border-destructive/20",
              )}
            >
              {health === "good" ? "healthy" : health === "warn" ? "degraded" : "critical"}
            </span>
          )}
        </div>

        {/* Key rows */}
        {loading ? (
          <div className="px-3.5 py-5 text-center text-[11px] text-muted-foreground font-mono">
            Loading…
          </div>
        ) : statuses.length === 0 ? (
          <div className="px-3.5 py-5 text-center text-[11px] text-muted-foreground font-mono">
            No OCR keys configured.
          </div>
        ) : (
          <div className="py-1.5">
            {sections.map(({ id: providerId, keys }, sectionIdx) => (
              <div key={providerId}>
                {/* Provider label — only show if more than one provider present */}
                {sections.length > 1 && (
                  <div
                    className={cn(
                      "px-3.5 pb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50",
                      sectionIdx > 0 ? "pt-2.5 border-t border-border/50 mt-1" : "pt-1.5",
                    )}
                  >
                    {PROVIDER_LABEL[providerId] ?? providerId}
                  </div>
                )}
                {keys.map((key) => (
                  <KeyRow key={key.id} status={key} />
                ))}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
