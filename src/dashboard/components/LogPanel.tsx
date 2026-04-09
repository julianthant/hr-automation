import React, { useEffect, useRef, useState } from "react";
import { Card, Button, Skeleton } from "@heroui/react";
import { motion, AnimatePresence } from "framer-motion";
import { getLogAction, type LogEntry } from "./types";

interface LogPanelProps {
  workflow: string;
  itemId: string;
  selectedDate: string;
  onClose: () => void;
}

const iconColorMap: Record<string, string> = {
  fill: "text-cyan-400",
  navigate: "text-slate-400",
  extract: "text-amber-400",
  search: "text-blue-400",
  select: "text-teal-400",
  auth: "text-purple-400",
  download: "text-green-400",
  step: "text-blue-400",
  success: "text-success",
  error: "text-danger",
  waiting: "text-warning",
};

export default function LogPanel({
  workflow,
  itemId,
  selectedDate,
  onClose,
}: LogPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!itemId) return;
    setLogs([]);
    setLoading(true);
    prevLenRef.current = 0;

    let sseUrl =
      "/events/logs?workflow=" +
      encodeURIComponent(workflow) +
      "&id=" +
      encodeURIComponent(itemId);
    if (selectedDate) sseUrl += "&date=" + encodeURIComponent(selectedDate);

    const es = new EventSource(sseUrl);

    es.onmessage = (e) => {
      try {
        const newEntries: LogEntry[] = JSON.parse(e.data);
        if (Array.isArray(newEntries)) {
          setLogs((prev) => [...prev, ...newEntries]);
          setLoading(false);
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      setLoading(false);
    };

    return () => es.close();
  }, [workflow, itemId, selectedDate]);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (bodyRef.current && logs.length > prevLenRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
    prevLenRef.current = logs.length;
  }, [logs]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <Card className="bg-content1 border border-divider rounded-lg mt-2 overflow-hidden">
          <Card.Header className="flex items-center justify-between px-4 py-2 border-b border-divider">
            <span className="font-mono text-xs font-semibold text-foreground-500 uppercase tracking-wider">
              Logs: {itemId}
            </span>
            <Button
              size="sm"
              variant="tertiary"
              onPress={onClose}
              aria-label="Close logs"
            >
              {"\u2715"}
            </Button>
          </Card.Header>
          <Card.Content className="p-0">
            <div
              ref={bodyRef}
              className="overflow-y-auto max-h-[370px] py-2"
            >
              {loading && logs.length === 0 ? (
                <div className="space-y-2 px-4 py-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-3 w-[60px] rounded" />
                      <Skeleton className="h-3 w-[14px] rounded" />
                      <Skeleton
                        className="h-3 rounded"
                        style={{ width: `${120 + i * 40}px` }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                logs.map((entry, i) => {
                  const action = getLogAction(entry.level, entry.message);
                  const ts = entry.ts
                    ? new Date(entry.ts).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    : "";
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-3 px-4 py-0.5 text-sm hover:bg-foreground-50/5"
                    >
                      <span className="font-mono text-xs text-foreground-500 whitespace-nowrap min-w-[72px] pt-0.5">
                        {ts}
                      </span>
                      <span
                        className={`shrink-0 w-4 text-center pt-0.5 ${iconColorMap[action.cls] || "text-foreground-500"}`}
                      >
                        {action.icon}
                      </span>
                      <span className="font-mono text-xs text-foreground-400 break-words">
                        {entry.message}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </Card.Content>
        </Card>
      </motion.div>
    </AnimatePresence>
  );
}
