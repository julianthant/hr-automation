import React, { useMemo } from "react";
import {
  Select,
  ListBox,
  Label,
  DatePicker,
  DateField,
  Calendar,
  SearchField,
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
        <Label>Workflow</Label>
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

      <SearchField
        aria-label="Search"
        value={searchQuery}
        onChange={setSearchQuery}
        className="flex-1"
      >
        <SearchField.SearchIcon />
        <SearchField.Input placeholder="Search by ID or name..." />
        <SearchField.ClearButton />
      </SearchField>

      <DatePicker
        aria-label="Date"
        value={dateValue}
        onChange={handleDateChange}
        className="min-w-[180px]"
      >
        <Label>Date</Label>
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
          <Calendar>
            <Calendar.Header>
              <Calendar.NavButton slot="previous" />
              <Calendar.NavButton slot="next" />
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(date) => <Calendar.Cell date={date} />}
              </Calendar.GridBody>
            </Calendar.Grid>
          </Calendar>
        </DatePicker.Popover>
      </DatePicker>
    </div>
  );
}
