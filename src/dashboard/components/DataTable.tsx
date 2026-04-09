import React, { useState, useEffect, useCallback, Fragment } from "react";
import { Chip, Skeleton } from "@heroui/react";
import LogPanel from "./LogPanel";
import {
  getConfig,
  parseColumns,
  type TrackerEntry,
  type WorkflowConfig,
} from "./types";

interface DataTableProps {
  rows: TrackerEntry[];
  activeWf: string;
  selectedDate: string;
  loading: boolean;
}

type ChipColor = "success" | "danger" | "accent" | "warning" | "default";

const statusColorMap: Record<string, ChipColor> = {
  done: "success",
  failed: "danger",
  running: "accent",
  pending: "warning",
  skipped: "default",
};

function CellContent({
  colKey,
  row,
  cfg,
}: {
  colKey: string;
  row: TrackerEntry;
  cfg: WorkflowConfig;
}) {
  switch (colKey) {
    case "id":
      return (
        <span className="font-mono text-sm font-medium max-w-[260px] truncate block">
          {row.id}
        </span>
      );
    case "_name":
      return (
        <span className="font-medium">
          {cfg.getName(row) || "\u2014"}
        </span>
      );
    case "_emplId":
      return (
        <span className="font-mono text-sm">
          {cfg.getExtra?.(row)?.emplId || "\u2014"}
        </span>
      );
    case "_saved": {
      const saved = cfg.getExtra?.(row)?.saved;
      return saved ? (
        <span className="text-success">{"\u2713"}</span>
      ) : (
        <span>{"\u2014"}</span>
      );
    }
    case "status":
      return (
        <Chip
          color={statusColorMap[row.status] || "default"}
          variant="soft"
          size="sm"
        >
          {row.status}
        </Chip>
      );
    case "step":
      return (
        <span className="font-mono text-xs text-foreground-500">
          {row.step || "\u2014"}
        </span>
      );
    case "error":
      return (
        <span
          className="font-mono text-xs text-danger max-w-[300px] truncate block hover:whitespace-normal hover:break-words"
          title={row.error || ""}
        >
          {row.error || ""}
        </span>
      );
    case "timestamp": {
      const t = row.timestamp
        ? new Date(row.timestamp).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "";
      return (
        <span className="font-mono text-xs text-foreground-500 whitespace-nowrap">
          {t}
        </span>
      );
    }
    default:
      return <span>{(row as unknown as Record<string, unknown>)[colKey]?.toString() || ""}</span>;
  }
}

export default function DataTable({
  rows,
  activeWf,
  selectedDate,
  loading,
}: DataTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const cfg = getConfig(activeWf);
  const columns = parseColumns(cfg.columns);

  // Reset expanded row when workflow changes
  useEffect(() => {
    setExpandedId(null);
  }, [activeWf]);

  const handleRowClick = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (loading) {
    return (
      <div className="bg-content1 border border-divider rounded-xl overflow-hidden" role="table" aria-label="Loading workflow entries">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className="font-mono text-[0.67rem] font-semibold uppercase tracking-widest text-foreground-500 px-4 py-3.5 text-left bg-content2 border-b border-divider"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-divider last:border-b-0">
                  {columns.map((c, j) => (
                    <td key={c.key} className="px-4 py-3">
                      <Skeleton
                        className="h-3.5 rounded"
                        style={{
                          width: `${50 + (((i + j) * 13) % 80)}px`,
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="bg-content1 border border-divider rounded-xl text-center py-20 px-5">
        <div className="text-5xl opacity-30 mb-4">{"\u25CE"}</div>
        <div className="text-lg font-semibold text-foreground-500 mb-2">
          No entries yet
        </div>
        <div className="text-sm text-foreground-400">
          Data will appear here as the workflow runs
        </div>
      </div>
    );
  }

  return (
    <div className="bg-content1 border border-divider rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" aria-label="Workflow entries">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="font-mono text-[0.67rem] font-semibold uppercase tracking-widest text-foreground-500 px-4 py-3.5 text-left bg-content2 border-b border-divider sticky top-0 z-[2] whitespace-nowrap"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr
                  className={`border-b border-divider last:border-b-0 cursor-pointer transition-colors hover:bg-content2/50 ${
                    expandedId === r.id ? "bg-content2" : ""
                  }`}
                  onClick={() => handleRowClick(r.id)}
                >
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-sm align-middle">
                      <CellContent colKey={c.key} row={r} cfg={cfg} />
                    </td>
                  ))}
                </tr>
                {expandedId === r.id && (
                  <tr>
                    <td colSpan={columns.length} className="p-0 px-2 pb-2">
                      <LogPanel
                        workflow={activeWf}
                        itemId={r.id}
                        selectedDate={selectedDate}
                        onClose={() => setExpandedId(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
