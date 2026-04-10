import { useState, useEffect, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";
import { TopBar } from "./components/TopBar";
import { QueuePanel } from "./components/QueuePanel";
import { LogPanel } from "./components/LogPanel";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { getConfig } from "./components/types";

/** Read initial state from URL search params so refresh preserves selection */
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    workflow: params.get("wf") || "onboarding",
    selectedId: params.get("id") || null,
    date: params.get("date") || new Date().toISOString().slice(0, 10),
  };
}

/** Sync state to URL without triggering a page reload */
function syncUrlState(workflow: string, selectedId: string | null, date: string) {
  const params = new URLSearchParams();
  params.set("wf", workflow);
  if (selectedId) params.set("id", selectedId);
  params.set("date", date);
  const url = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", url);
}

export default function App() {
  const initial = useMemo(readUrlState, []);
  const [workflow, setWorkflow] = useState(initial.workflow);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [date, setDate] = useState(initial.date);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const prevStatusRef = useMemo(() => new Map<string, string>(), []);

  // Pre-flight check on mount
  usePreflight();

  // Sync state to URL so refresh preserves selection
  useEffect(() => {
    syncUrlState(workflow, selectedId, date);
  }, [workflow, selectedId, date]);

  // SSE entries
  const { entries, workflows, wfCounts, connected, loading } = useEntries(workflow, date);

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

  // Entry counts per workflow from backend SSE (accurate across all workflows)
  const entryCounts = wfCounts;

  const selectedEntry = entries.find((e) => e.id === selectedId) || null;

  return (
    <div className="flex flex-col h-screen">
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
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
