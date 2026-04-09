import React from "react";
import { Card } from "@heroui/react";
import type { TrackerEntry } from "./types";

interface StatsRowProps {
  rows: TrackerEntry[];
}

const stats = [
  { key: "total", label: "Total", borderColor: "border-t-foreground-400" },
  { key: "done", label: "Completed", borderColor: "border-t-success" },
  { key: "failed", label: "Failed", borderColor: "border-t-danger" },
  { key: "running", label: "Running", borderColor: "border-t-primary" },
  { key: "pending", label: "Pending", borderColor: "border-t-warning" },
] as const;

const textColorMap: Record<string, string> = {
  total: "text-foreground",
  done: "text-success",
  failed: "text-danger",
  running: "text-primary",
  pending: "text-warning",
};

export default function StatsRow({ rows }: StatsRowProps) {
  const counts: Record<string, number> = {
    total: rows.length,
    done: rows.filter((r) => r.status === "done").length,
    failed: rows.filter((r) => r.status === "failed").length,
    running: rows.filter((r) => r.status === "running").length,
    pending: rows.filter(
      (r) => r.status === "pending" || r.status === "skipped"
    ).length,
  };

  return (
    <div className="grid grid-cols-5 gap-3 mb-3">
      {stats.map((s) => (
        <Card
          key={s.key}
          className={`border-t-2 ${s.borderColor}`}
        >
          <Card.Content className="px-5 py-4">
            <div className={`text-3xl font-bold tracking-tight ${textColorMap[s.key]}`}>
              {counts[s.key]}
            </div>
            <div className="text-foreground-500 text-xs font-mono uppercase tracking-widest mt-1">
              {s.label}
            </div>
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}
