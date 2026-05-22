import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

type KeyStateKind = "available" | "throttled" | "quota-exhausted" | "dead";

interface OcrKeyStatus {
  id: string;
  providerId: ProviderId;
  state:
    | { kind: "available" }
    | { kind: "throttled"; untilMs: number }
    | { kind: "quota-exhausted"; untilMs: number }
    | { kind: "dead" };
  dailyCount?: number;
}

// ── Config ─────────────────────────────────────────────────────────────────

type ProviderId = "gemini" | "mistral" | "groq" | "sambanova";

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
  sambanova: "Sambanova",
};

const PROVIDER_ORDER: ProviderId[] = ["gemini", "mistral", "groq", "sambanova"];

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
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("gemini");
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

  const byProvider: Record<ProviderId, OcrKeyStatus[]> = {
    gemini: [],
    mistral: [],
    groq: [],
    sambanova: [],
  };
  for (const s of statuses) (byProvider[s.providerId] ??= []).push(s);
  const selectedKeys = byProvider[selectedProvider] ?? [];

  const triggerLabel =
    geminiKeys.length > 0
      ? `G·${geminiAvail}/${geminiKeys.length}`
      : statuses.length > 0
        ? `AI·${statuses.length}`
        : "AI";

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
        <div className="px-3.5 pt-3 pb-2.5 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              OCR Key Pool
            </div>
          </div>
          <select
            aria-label="Select OCR provider"
            value={selectedProvider}
            onChange={(event) => setSelectedProvider(event.target.value as ProviderId)}
            className={cn(
              "h-7 min-w-[112px] rounded border border-border bg-secondary px-2",
              "font-mono text-[10px] font-semibold uppercase tracking-wider text-foreground",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          >
            {PROVIDER_ORDER.map((providerId) => (
              <option key={providerId} value={providerId}>
                {PROVIDER_LABEL[providerId]} ({byProvider[providerId].length})
              </option>
            ))}
          </select>
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
        ) : selectedKeys.length === 0 ? (
          <div className="px-3.5 py-5 text-center text-[11px] text-muted-foreground font-mono">
            No {PROVIDER_LABEL[selectedProvider]} keys configured.
          </div>
        ) : (
          <div className="py-1.5">
            {selectedKeys.map((key) => (
              <KeyRow key={key.id} status={key} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
