import { cn } from "@/lib/utils";
import { Check, X, KeyRound, Loader2, Hourglass } from "lucide-react";
import type { AuthState } from "@/components/shared/types";

interface BrowserChipProps {
  system: string;
  authState: AuthState;
}

const chipStyles: Record<AuthState, string> = {
  idle: "bg-muted text-muted-foreground border-border",
  authenticating: "bg-info/15 text-info border-info/30",
  authed: "bg-success/15 text-success border-success/30",
  duo_waiting: "bg-warning/15 text-warning border-warning/30 motion-safe:animate-pulse",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
};

const chipIcons: Record<AuthState, React.ReactNode> = {
  idle: <Hourglass className="w-3 h-3" />,
  authenticating: <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" />,
  authed: <Check className="w-3 h-3" />,
  duo_waiting: <KeyRound className="w-3 h-3" />,
  failed: <X className="w-3 h-3" />,
};

export function BrowserChip({ system, authState }: BrowserChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border",
        chipStyles[authState],
      )}
    >
      {chipIcons[authState]}
      {system}
    </span>
  );
}
