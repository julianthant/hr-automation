import React from "react";
import { ProgressBar as HeroProgressBar } from "@heroui/react";
import type { TrackerEntry } from "./types";

interface ProgressBarProps {
  rows: TrackerEntry[];
}

export default function ProgressBarSection({ rows }: ProgressBarProps) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex items-center gap-4 mb-6">
      <HeroProgressBar
        value={pct}
        color="success"
        className="flex-1"
        aria-label="Completion progress"
      >
        <HeroProgressBar.Track>
          <HeroProgressBar.Fill />
        </HeroProgressBar.Track>
      </HeroProgressBar>
      <span className="font-mono text-sm text-foreground-500 min-w-[48px] text-right">
        {pct}%
      </span>
    </div>
  );
}
