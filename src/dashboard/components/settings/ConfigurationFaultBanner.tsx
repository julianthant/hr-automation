import { AlertTriangle } from "lucide-react";

import { useSettings } from "@/components/hooks/useSettings";

export function ConfigurationFaultBanner({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): JSX.Element | null {
  const { configuration } = useSettings();
  if (configuration?.state !== "fault") return null;

  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-destructive/40 bg-destructive/12 px-4 py-2 text-sm text-foreground"
    >
      <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 truncate">
        Configuration fault — workflow launches are blocked until settings are repaired.
      </span>
      <button
        type="button"
        onClick={onOpenSettings}
        className="shrink-0 rounded-md border border-destructive/40 bg-background px-3 py-1 text-xs font-medium outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
      >
        Repair settings
      </button>
    </div>
  );
}
