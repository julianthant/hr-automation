import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Optional call-to-action rendered under the description (e.g. a Run button). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 text-center p-8", className)}>
      <Icon className="h-10 w-10 text-muted-foreground opacity-30" />
      <div className="text-base font-semibold text-foreground">{title}</div>
      <div className="text-sm text-muted-foreground">{description}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
