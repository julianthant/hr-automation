import { useEffect, useMemo, useState } from "react";
import { Images } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { resolveEntryName } from "@/components/shared/entry-display";
import type { TrackerEntry } from "@/components/shared/types";
import { useRunScreenshots } from "@/components/hooks/useRunScreenshots";
import { queueStatusDisplayLabel } from "../../../domain/tracker-terminal-display.js";

export function BatchScreenshotsPanel({
  members,
  displayNames,
  title,
}: {
  members: TrackerEntry[];
  displayNames?: Map<string, string>;
  title: string;
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  const hasLiveMembers = members.some(
    (member) => member.status === "pending" || member.status === "running",
  );

  useEffect(() => {
    if (!hasLiveMembers) return;
    const id = window.setInterval(() => setRefreshTick((v) => v + 1), 3_000);
    return () => window.clearInterval(id);
  }, [hasLiveMembers]);

  if (members.length === 0) {
    return (
      <div className="flex-1 bg-card">
        <EmptyState
          icon={Images}
          title="No batch rows"
          description="Rows will appear here as this batch starts processing"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-card">
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <Images className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground truncate">
            {title}
          </h2>
          <span className="ml-auto rounded border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
            {members.length} rows
          </span>
        </div>
      </div>

      <div className="space-y-5 px-6 py-5">
        {members.map((member, index) => (
          <BatchScreenshotRow
            key={`${member.workflow}-${member.id}-${member.runId ?? ""}`}
            member={member}
            ordinal={index + 1}
            displayName={resolveEntryName(member, displayNames)}
            refreshTick={refreshTick}
          />
        ))}
      </div>
    </div>
  );
}

function BatchScreenshotRow({
  member,
  ordinal,
  displayName,
  refreshTick,
}: {
  member: TrackerEntry;
  ordinal: number;
  displayName: string;
  refreshTick: number;
}) {
  const { entries } = useRunScreenshots(
    member.workflow,
    member.id,
    refreshTick,
  );

  const ordered = useMemo(
    () => [...entries].sort((a, b) => a.ts - b.ts),
    [entries],
  );

  return (
    <section className="border-b border-border pb-5 last:border-b-0 last:pb-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
          #{ordinal}
        </span>
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {displayName}
        </h3>
        <span className="ml-auto rounded border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {queueStatusDisplayLabel({
            workflow: member.workflow,
            status: member.status,
            data: member.data,
          })}
        </span>
      </div>

      {ordered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/50 px-4 py-5 text-sm text-muted-foreground">
          No screenshots captured for this row yet.
        </div>
      ) : (
        <div className="space-y-4">
          {ordered.map((entry) => (
            <div
              key={`${member.id}-${entry.ts}-${entry.label}`}
              className="rounded-md border border-border bg-background/70 p-3"
            >
              <div className="mb-3 flex items-center gap-2 text-xs">
                <span
                  className={
                    entry.kind === "error"
                      ? "rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-destructive"
                      : "rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-primary"
                  }
                >
                  {entry.kind}
                </span>
                {entry.step ? (
                  <span className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {entry.step}
                  </span>
                ) : null}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {new Date(entry.ts).toLocaleString()}
                </span>
                <span
                  className="ml-auto max-w-[45%] truncate text-[11px] font-mono text-foreground/80"
                  title={entry.label}
                >
                  {entry.label}
                </span>
              </div>

              <div className="space-y-4">
                {entry.files.map((file) => (
                  <figure key={file.path} className="space-y-2">
                    <img
                      src={file.url}
                      srcSet={file.url}
                      sizes="calc(100vw - 24rem)"
                      alt={`${displayName} ${file.system} screenshot`}
                      className="block w-full rounded-md border border-border bg-black/30 object-contain"
                      loading="lazy"
                    />
                    <figcaption className="text-center text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                      {file.system}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
