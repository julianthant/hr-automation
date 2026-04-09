import React, { useMemo } from "react";
import {
  Select,
  ListBox,
  SearchField,
  DatePicker,
  DateField,
  Calendar,
} from "@heroui/react";
import {
  parseDate,
  today,
  getLocalTimeZone,
  type CalendarDate,
} from "@internationalized/date";
import { TAB_ORDER, getConfig } from "./types";

interface FilterBarProps {
  activeWf: string;
  workflows: string[];
  onSwitch: (wf: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  availableDates: string[];
  statusFilter: string | null;
  setStatusFilter: (s: string | null) => void;
  statusCounts: Record<string, number>;
}

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "pending", label: "Pending" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
];

export default function FilterBar({
  activeWf,
  workflows,
  onSwitch,
  searchQuery,
  setSearchQuery,
  selectedDate,
  setSelectedDate,
  statusFilter,
  setStatusFilter,
  statusCounts,
}: FilterBarProps) {
  const allWfs = useMemo(() => {
    const ordered = TAB_ORDER.filter(
      (wf) => wf === activeWf || workflows.includes(wf)
    );
    workflows.forEach((wf) => {
      if (!ordered.includes(wf)) ordered.push(wf);
    });
    if (!ordered.includes(activeWf)) ordered.unshift(activeWf);
    return ordered;
  }, [activeWf, workflows]);

  const dateValue = useMemo(() => {
    try {
      return parseDate(selectedDate);
    } catch {
      return today(getLocalTimeZone());
    }
  }, [selectedDate]);

  const handleDateChange = (value: CalendarDate | null) => {
    if (value) setSelectedDate(value.toString());
  };

  const statusKey = statusFilter || "all";
  const totalCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  // Shared style: darker bg for inputs inside the card
  const inputBg = "rounded-lg bg-[#2a2a2a] border border-[#3a3a3a]";

  return (
    <div className="mb-6 rounded-xl p-4 bg-[#1a1a1a] border border-[#2d2d2d]">
      <div className="grid grid-cols-4 gap-4 items-center">
          {/* Workflow Select */}
          <div className={inputBg}>
            <Select
              aria-label="Workflow"
              selectedKey={activeWf}
              onSelectionChange={(key) => {
                if (key) onSwitch(String(key));
              }}
              variant="secondary"
              className="[&_button]:!bg-transparent [&_button]:!shadow-none"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {allWfs.map((wf) => (
                    <ListBox.Item key={wf} id={wf} textValue={getConfig(wf).label}>
                      {getConfig(wf).label}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* Search Field */}
          <div className={inputBg}>
            <SearchField
              aria-label="Search"
              value={searchQuery}
              onChange={setSearchQuery}
              variant="secondary"
              className="[&_div]:!bg-transparent [&_div]:!shadow-none"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Search by ID or name..." />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </div>

          {/* Status Select */}
          <div className={inputBg}>
            <Select
              aria-label="Status"
              selectedKey={statusKey}
              onSelectionChange={(key) => {
                if (key) {
                  setStatusFilter(String(key) === "all" ? null : String(key));
                }
              }}
              variant="secondary"
              className="[&_button]:!bg-transparent [&_button]:!shadow-none"
            >
              <Select.Trigger>
                <Select.Value>
                  {statusKey === "all"
                    ? `All Status (${totalCount})`
                    : `${STATUS_OPTIONS.find((s) => s.key === statusKey)?.label} (${statusCounts[statusKey] || 0})`}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {STATUS_OPTIONS.map((s) => {
                    const count =
                      s.key === "all" ? totalCount : statusCounts[s.key] || 0;
                    return (
                      <ListBox.Item key={s.key} id={s.key} textValue={s.label}>
                        <span className="flex items-center justify-between w-full">
                          <span>{s.label}</span>
                          <span className="text-foreground-500 text-xs font-mono">
                            {count}
                          </span>
                        </span>
                      </ListBox.Item>
                    );
                  })}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* Date Picker */}
          <div className={inputBg}>
            <DatePicker
              aria-label="Date"
              value={dateValue}
              onChange={handleDateChange}
              variant="secondary"
              className="[&_div[data-slot]]:!bg-transparent [&_div]:!shadow-none"
            >
              <DateField.Group>
                <DateField.Input>
                  {(segment) => <DateField.Segment segment={segment} />}
                </DateField.Input>
                <DateField.Suffix>
                  <DatePicker.Trigger>
                    <DatePicker.TriggerIndicator />
                  </DatePicker.Trigger>
                </DateField.Suffix>
              </DateField.Group>
              <DatePicker.Popover>
                <div className="p-3">
                  <Calendar>
                    <Calendar.Header>
                      <Calendar.NavButton slot="previous" />
                      <Calendar.NavButton slot="next" />
                    </Calendar.Header>
                    <Calendar.Grid>
                      <Calendar.GridHeader>
                        {(day) => (
                          <Calendar.HeaderCell>{day}</Calendar.HeaderCell>
                        )}
                      </Calendar.GridHeader>
                      <Calendar.GridBody>
                        {(date) => <Calendar.Cell date={date} />}
                      </Calendar.GridBody>
                    </Calendar.Grid>
                  </Calendar>
                </div>
              </DatePicker.Popover>
            </DatePicker>
          </div>
      </div>
    </div>
  );
}
