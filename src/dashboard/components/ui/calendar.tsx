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

  const handleChange = (date: CalendarDate | null) => {
    if (date) onSelect(date.toString());
  };

  return (
    <HeroCalendar
      value={value}
      onChange={handleChange}
      aria-label="Select date"
    >
      <HeroCalendar.Header>
        <HeroCalendar.NavButton slot="previous" />
        <HeroCalendar.NavButton slot="next" />
      </HeroCalendar.Header>
      <HeroCalendar.Grid>
        <HeroCalendar.GridHeader>
          {(day) => <HeroCalendar.HeaderCell>{day}</HeroCalendar.HeaderCell>}
        </HeroCalendar.GridHeader>
        <HeroCalendar.GridBody>
          {(date) => <HeroCalendar.Cell date={date} />}
        </HeroCalendar.GridBody>
      </HeroCalendar.Grid>
    </HeroCalendar>
  );
}
