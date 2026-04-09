import React, { useState, useEffect, useCallback, useMemo } from "react";
import FilterBar from "./components/FilterBar";
import StatsRow from "./components/StatsRow";
// ProgressBar removed per user request
import DataTable from "./components/DataTable";
import { useClock } from "./components/hooks";
import {
  getConfig,
  STATUS_ORDER,
  type TrackerEntry,
} from "./components/types";

export default function App() {
  const [activeWf, setActiveWf] = useState("onboarding");
  const [rows, setRows] = useState<TrackerEntry[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDate, setSelectedDate] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const clock = useClock();

  // Fetch available dates when workflow changes
  useEffect(() => {
    fetch("/api/dates?workflow=" + encodeURIComponent(activeWf))
      .then((r) => r.json())
      .then((dates: string[]) => {
        setAvailableDates(dates);
        const today = new Date().toISOString().slice(0, 10);
        if (!dates.includes(selectedDate)) {
          setSelectedDate(dates[0] || today);
        }
      })
      .catch(() => {});
  }, [activeWf]);

  // SSE connection includes date
  useEffect(() => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    let sseUrl = "/events?workflow=" + encodeURIComponent(activeWf);
    if (selectedDate && selectedDate !== today) {
      sseUrl += "&date=" + encodeURIComponent(selectedDate);
    }

    const es = new EventSource(sseUrl);

    es.onmessage = (e) => {
      try {
        const {
          entries,
          workflows: wfs,
        }: { entries: TrackerEntry[]; workflows: string[] } = JSON.parse(
          e.data
        );

        // Dedupe by ID, keep latest
        const latest = new Map<string, TrackerEntry>();
        entries.forEach((en) => latest.set(en.id, en));
        const deduped = [...latest.values()];

        // Sort: running first, then pending, then failed, then done
        deduped.sort(
          (a, b) =>
            (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
        );

        setRows(deduped);
        setWorkflows(wfs || []);
        setLoading(false);
      } catch {
        // ignore
      }
    };

    es.onerror = () => {};

    return () => es.close();
  }, [activeWf, selectedDate]);

  // Update document title
  useEffect(() => {
    const cfg = getConfig(activeWf);
    document.title = cfg.label + " \u2014 HR Automation";
  }, [activeWf]);

  // Clear search and status filter when switching workflows
  const handleWorkflowChange = useCallback((wf: string) => {
    setActiveWf(wf);
    setSearchQuery("");
    setStatusFilter(null);
  }, []);

  // Filter rows by search query and status
  const cfg = getConfig(activeWf);
  const filteredRows = useMemo(() => {
    let filtered = rows;
    if (statusFilter) {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((r) => {
        const name = (cfg.getName(r) || "").toLowerCase();
        return r.id.toLowerCase().includes(q) || name.includes(q);
      });
    }
    return filtered;
  }, [rows, searchQuery, statusFilter, cfg]);

  // Status counts (before search filter, so chips show true counts)
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const base = searchQuery
      ? rows.filter((r) => {
          const q = searchQuery.toLowerCase();
          const name = (cfg.getName(r) || "").toLowerCase();
          return r.id.toLowerCase().includes(q) || name.includes(q);
        })
      : rows;
    for (const r of base) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return counts;
  }, [rows, searchQuery, cfg]);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-7">
      {/* Header */}
      <header className="flex items-center justify-between pb-6 border-b border-divider mb-6">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight">
            HR Automation
          </span>
          <span className="text-foreground-500 font-normal">Control</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-success">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse shadow-[0_0_8px_rgba(63,185,80,0.5)]" />
            <span>Live</span>
          </div>
          <span className="font-mono text-xs text-foreground-500 tracking-wide">
            {clock}
          </span>
        </div>
      </header>

      {/* Stats first */}
      <StatsRow rows={filteredRows} />

      {/* Filter Bar */}
      <FilterBar
        activeWf={activeWf}
        workflows={workflows}
        onSwitch={handleWorkflowChange}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        availableDates={availableDates}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        statusCounts={statusCounts}
      />

      {/* Table */}
      <DataTable
        rows={filteredRows}
        activeWf={activeWf}
        selectedDate={selectedDate}
        loading={loading}
      />
    </div>
  );
}
