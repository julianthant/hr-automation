import { cn } from "@/lib/utils";

export function ExpiryFooter({
  expiresAt,
  currentExpiresAt,
  now,
  extending,
  onExtend,
  terminal,
}: {
  expiresAt: number;
  currentExpiresAt: number;
  now: number;
  extending: boolean;
  onExtend: () => void;
  terminal: boolean;
}) {
  if (terminal) return null;
  const remaining = Math.max(0, currentExpiresAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  const critical = seconds <= 10;
  const warning = !critical && seconds <= 60;

  return (
    <div
      className="flex items-center justify-between text-[11.5px] pt-3.5"
      style={{
        borderTop: "1px solid var(--capture-border-subtle)",
        color: "var(--capture-fg-muted)",
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "font-mono tabular-nums transition-colors",
            (warning || critical) && "motion-safe:animate-pulse",
          )}
          style={{
            color: critical
              ? "var(--capture-error)"
              : warning
                ? "var(--capture-warn)"
                : "var(--capture-fg-secondary)",
          }}
        >
          {mm}:{ss}
        </span>
        <span>remaining</span>
      </span>
      <button
        type="button"
        onClick={onExtend}
        disabled={extending}
        className="font-sans text-[11.5px] cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
        style={{
          color: "var(--capture-fg-secondary)",
          backgroundColor: "transparent",
          border: 0,
          padding: 0,
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
      >
        {extending ? "extending…" : "Extend"}
      </button>
      <span className="sr-only">Original expiry: {new Date(expiresAt).toLocaleTimeString()}</span>
    </div>
  );
}
