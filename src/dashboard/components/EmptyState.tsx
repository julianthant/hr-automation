import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 text-center p-8", className)}>
      <Icon className="h-10 w-10 text-muted-foreground opacity-30" />
      <div className="text-base font-semibold text-muted-foreground">{title}</div>
      <div className="text-sm text-muted-foreground/70">{description}</div>
    </div>
  );
}
