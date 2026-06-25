import {
  CloudDownload,
  Contact,
  Database,
  FileDown,
  FileSearch,
  FileText,
  FileUp,
  GraduationCap,
  type LucideIcon,
  PenLine,
  ScanText,
  UserMinus,
  UserPlus,
  UserSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowListEntry } from "./useWorkflowPresentation.js";

const ICONS: Record<string, LucideIcon> = {
  ocr: ScanText,
  "crm-doc-download": FileDown,
  "emergency-contact": Contact,
  "oath-signature": PenLine,
  "oath-upload": FileUp,
  onbase: Database,
  onboarding: UserPlus,
  "person-lookup": UserSearch,
  separations: UserMinus,
  "sharepoint-download": CloudDownload,
  "work-study": GraduationCap,
  "i9-lookup": FileSearch,
};

interface WorkflowPickerProps {
  list: WorkflowListEntry[];
  selected: string | null;
  /** Live total override count for the selected workflow (from the draft). */
  selectedCount: number;
  onSelect: (name: string) => void;
}

export function WorkflowPicker({
  list,
  selected,
  selectedCount,
  onSelect,
}: WorkflowPickerProps): JSX.Element {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-border">
      <div className="px-3 pb-1 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Workflows
        </p>
      </div>
      <nav className="px-1.5 pb-3">
        {list.map((w) => {
          const Icon = ICONS[w.name] ?? FileText;
          const active = selected === w.name;
          return (
            <button
              key={w.name}
              type="button"
              aria-label={`Configure ${w.label}`}
              aria-pressed={active}
              onClick={() => onSelect(w.name)}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon
                aria-hidden
                className={cn("h-4 w-4 shrink-0", active ? "text-primary-foreground" : "text-muted-foreground")}
              />
              <span className="flex-1 truncate">{w.label}</span>
              {active && selectedCount > 0 ? (
                <span
                  className="inline-flex items-center rounded-full bg-primary-foreground/20 px-1.5 py-px text-[11px] font-semibold leading-none text-primary-foreground"
                  aria-label={`${selectedCount} override${selectedCount !== 1 ? "s" : ""}`}
                >
                  {selectedCount}
                </span>
              ) : !active && w.hasOverride ? (
                <span
                  aria-label="has saved overrides"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                />
              ) : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
