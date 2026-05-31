import { ArrowDownWideNarrow } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  QUEUE_SORT_OPTIONS,
  type QueueSortMode,
} from "./queue-sort";

interface QueueSortDropdownProps {
  value: QueueSortMode;
  onChange: (mode: QueueSortMode) => void;
  disabled?: boolean;
  /** Merged onto the dropdown wrapper (e.g. `flex-1 min-w-0` beside toolbar icons). */
  className?: string;
}

export function QueueSortDropdown({
  value,
  onChange,
  disabled,
  className,
}: QueueSortDropdownProps) {
  const active = QUEUE_SORT_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <div className={cn("min-w-0", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          disabled={disabled}
          aria-label={`Queue sort: ${active}. Open menu.`}
          title={active}
          className={cn(
            "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-left text-[11px] font-medium text-foreground outline-none transition-colors",
            "hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
            "data-[state=open]:border-primary/40 data-[state=open]:bg-secondary/70",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span className="truncate">{active}</span>
          <ArrowDownWideNarrow aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem]">
          {QUEUE_SORT_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(opt.value === value && "bg-accent")}
            >
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
