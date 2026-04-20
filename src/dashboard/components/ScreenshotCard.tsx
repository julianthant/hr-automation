import type { ScreenshotEntry } from "./hooks/useRunScreenshots";

export function ScreenshotCard({
  entry,
  onOpen,
}: {
  entry: ScreenshotEntry;
  onOpen: (entry: ScreenshotEntry, fileIdx: number) => void;
}) {
  const kindClass =
    entry.kind === "error"
      ? "bg-destructive/10 text-destructive border-destructive/30"
      : "bg-primary/10 text-primary border-primary/30";

  return (
    <div className="border-b border-r rounded-md p-3 bg-background">
      <div className="flex items-center gap-2 text-xs mb-2 flex-wrap">
        <span
          className={`px-2 py-0.5 rounded border font-mono uppercase tracking-wider text-[10px] ${kindClass}`}
        >
          {entry.kind}
        </span>
        {entry.step && (
          <span className="px-2 py-0.5 rounded border bg-muted text-muted-foreground border-border font-mono text-[10px] uppercase tracking-wider">
            {entry.step}
          </span>
        )}
        <span className="font-mono text-muted-foreground text-[11px]">
          {new Date(entry.ts).toLocaleString()}
        </span>
        <span
          className="font-mono text-foreground/80 ml-auto truncate max-w-[50%] text-[11px]"
          title={entry.label}
        >
          {entry.label}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {entry.files.map((f, i) => (
          <button
            key={f.path}
            type="button"
            className="flex-shrink-0 text-xs text-muted-foreground hover:ring-2 hover:ring-primary/50 rounded transition-shadow"
            onClick={() => onOpen(entry, i)}
          >
            <img
              src={f.url}
              alt={f.system}
              className="w-32 h-20 object-cover border-b border-r rounded"
              loading="lazy"
            />
            <div className="mt-1 text-center font-mono text-[10px] uppercase tracking-wider">
              {f.system}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
