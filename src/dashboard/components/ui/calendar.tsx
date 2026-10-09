"use client";

import { useState, useEffect } from "react";
import { Calendar as HeroCalendar } from "@heroui/react";
import { parseDate, type CalendarDate } from "@internationalized/date";

interface CalendarProps {
  selected: string; // YYYY-MM-DD
  onSelect: (date: string) => void;
}

export function Calendar({ selected, onSelect }: CalendarProps) {
  const value = (() => {
    try {
      return parseDate(selected);
    } catch {
      return undefined;
    }
  })();

  const [focusedValue, setFocusedValue] = useState<CalendarDate | undefined>(value);

  // Sync focused month to selected date whenever the selection changes (e.g. popover reopens on a different date)
  useEffect(() => {
    setFocusedValue(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const handleChange = (date: CalendarDate | null) => {
    if (date) onSelect(date.toString());
  };

  return (
    <HeroCalendar
      value={value}
      onChange={handleChange}
      focusedValue={focusedValue}
      onFocusChange={setFocusedValue}
      aria-label="Select date"
    >
      <HeroCalendar.Header>
        <HeroCalendar.NavButton className="text-foreground" slot="previous" />
        <HeroCalendar.YearPickerTrigger className="w-full justify-center">
          <HeroCalendar.YearPickerTriggerHeading className="text-foreground" />
          <HeroCalendar.YearPickerTriggerIndicator className="text-foreground" />
        </HeroCalendar.YearPickerTrigger>
        <HeroCalendar.NavButton className="text-foreground" slot="next" />
      </HeroCalendar.Header>
      <HeroCalendar.Grid>
        <HeroCalendar.GridHeader>
          {(day) => <HeroCalendar.HeaderCell>{day}</HeroCalendar.HeaderCell>}
        </HeroCalendar.GridHeader>
        <HeroCalendar.GridBody>
          {(date) => <HeroCalendar.Cell date={date} />}
        </HeroCalendar.GridBody>
      </HeroCalendar.Grid>
      <HeroCalendar.YearPickerGrid>
        <HeroCalendar.YearPickerGridBody>
          {({ year }) => <HeroCalendar.YearPickerCell year={year} />}
        </HeroCalendar.YearPickerGridBody>
      </HeroCalendar.YearPickerGrid>
    </HeroCalendar>
  );
}
