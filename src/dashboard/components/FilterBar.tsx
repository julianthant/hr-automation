import React, { useMemo } from "react";
import {
  Select,
  SelectValue,
  ListBox,
  ListBoxItem,
  SearchField,
  SearchFieldInput,
  SearchFieldClearButton,
  SearchFieldSearchIcon,
  DatePicker,
} from "@heroui/react";
import { parseDate, today, getLocalTimeZone, type CalendarDate } from "@internationalized/date";
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
}

export default function FilterBar({
  activeWf,
  workflows,
  onSwitch,
  searchQuery,
  setSearchQuery,
  selectedDate,
  setSelectedDate,
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
    if (value) {
      setSelectedDate(value.toString());
    }
  };

  return (
    <div className="flex items-center gap-3 bg-content1/80 backdrop-blur-xl border border-divider rounded-xl shadow-lg p-3 mb-6">
      <Select
        aria-label="Workflow"
        selectedKey={activeWf}
        onSelectionChange={(key) => {
          if (key) onSwitch(String(key));
        }}
        className="min-w-[180px]"
      >
        <SelectValue />
        <ListBox>
          {allWfs.map((wf) => (
            <ListBoxItem key={wf} id={wf}>
              {getConfig(wf).label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select>

      <SearchField
        aria-label="Search"
        value={searchQuery}
        onChange={setSearchQuery}
        className="flex-1"
      >
        <SearchFieldSearchIcon />
        <SearchFieldInput placeholder="Search by ID or name..." />
        <SearchFieldClearButton />
      </SearchField>

      <DatePicker
        aria-label="Date"
        value={dateValue}
        onChange={handleDateChange}
        className="min-w-[180px]"
      />
    </div>
  );
}
