import { useState, useEffect, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";
import { TopBar } from "./components/TopBar";
import { QueuePanel } from "./components/QueuePanel";
import { LogPanel } from "./components/LogPanel";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { getConfig } from "./components/types";

export default function App() {
  const [workflow, setWorkflow] = useState("onboarding");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const prevStatusRef = useMemo(() => new Map<string, string>(), []);

  // Pre-flight check on mount
  usePreflight();

  // SSE entries
  const { entries, workflows, connected, loading } = useEntries(workflow, date);

  // Fetch available dates when workflow changes
  useEffect(() => {
    fetch("/api/dates?workflow=" + encodeURIComponent(workflow))
      .then((r) => r.json())
      .then((dates: string[]) => {
        setAvailableDates(dates);
        const today = new Date().toISOString().slice(0, 10);
        if (!dates.includes(date)) setDate(dates[0] || today);
      })
      .catch(() => {});
  }, [workflow]);

  // Toast on completion/failure
  useEffect(() => {
    for (const entry of entries) {
      const prevStatus = prevStatusRef.get(entry.id);
      if (prevStatus && prevStatus !== entry.status) {
        const cfg = getConfig(workflow);
        const name = cfg.getName(entry) || entry.id;
        if (entry.status === "done") {
          toast.success(`${name} completed`, {
            description: `${cfg.label} finished`,
            duration: 5000,
          });
        } else if (entry.status === "failed") {
          toast.error(`${name} failed`, {
            description: entry.error || "Unknown error",
            duration: 8000,
          });
        }
      }
      prevStatusRef.set(entry.id, entry.status);
    }
  }, [entries, workflow, prevStatusRef]);

  // Update document title
  useEffect(() => {
    const running = entries.filter((e) => e.status === "running").length;
    document.title = running > 0 ? `${running} running \u2014 HR Dashboard` : "HR Dashboard";
  }, [entries]);

  // Clear selection when switching workflows
  const handleWorkflowChange = useCallback((wf: string) => {
    setWorkflow(wf);
    setSelectedId(null);
  }, []);

  // Entry counts per workflow for dropdown badges
  const entryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const wf of workflows) counts[wf] = 0;
    counts[workflow] = entries.length;
    return counts;
  }, [workflows, workflow, entries.length]);

  const selectedEntry = entries.find((e) => e.id === selectedId) || null;

  return (
    <div className="flex flex-col h-screen">
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            color: "hsl(var(--foreground))",
          },
        }}
      />
      <TopBar
        workflow={workflow}
        workflows={workflows}
        onWorkflowChange={handleWorkflowChange}
        date={date}
        onDateChange={setDate}
        availableDates={availableDates}
        connected={connected}
        entryCounts={entryCounts}
      />
      <div className="flex flex-1 overflow-hidden">
        <QueuePanel
          entries={entries}
          workflow={workflow}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loading}
        />
        <LogPanel
          entry={selectedEntry}
          workflow={workflow}
          date={date}
        />
      </div>
    </div>
  );
}
