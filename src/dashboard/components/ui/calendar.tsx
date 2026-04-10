import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center text-sm font-medium",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        button_previous: cn(
          "absolute left-1 top-0 inline-flex items-center justify-center rounded-md h-7 w-7",
          "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground cursor-pointer",
          "text-muted-foreground",
        ),
        button_next: cn(
          "absolute right-1 top-0 inline-flex items-center justify-center rounded-md h-7 w-7",
          "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground cursor-pointer",
          "text-muted-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: cn(
          "relative p-0 text-center text-sm focus-within:relative focus-within:z-20",
          "h-9 w-9 inline-flex items-center justify-center rounded-md",
          "hover:bg-accent hover:text-accent-foreground cursor-pointer",
          "aria-selected:opacity-100",
        ),
        day_button: cn(
          "h-9 w-9 inline-flex items-center justify-center rounded-md text-sm",
          "hover:bg-accent hover:text-accent-foreground cursor-pointer",
          "focus:outline-none",
        ),
        selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
        today: "bg-accent text-accent-foreground font-semibold",
        outside: "text-muted-foreground/40",
        disabled: "text-muted-foreground/30",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
