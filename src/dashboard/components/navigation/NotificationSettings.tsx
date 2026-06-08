import { useState } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  notificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  type NotifySettings,
} from "@/lib/desktop-notifications";

interface NotificationSettingsProps {
  settings: NotifySettings;
  onChange: (settings: NotifySettings) => void;
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-foreground">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "border-success/50 bg-success/40" : "border-border bg-accent",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-[2px] h-[12px] w-[12px] rounded-full transition-[left]",
            checked ? "left-[16px] bg-success" : "left-[2px] bg-foreground",
          )}
        />
      </button>
      <span>{label}</span>
    </label>
  );
}

/**
 * Navbar bell that opens a popover for desktop-notification settings: request
 * permission (a user gesture, as browsers require) and toggle the two triggers.
 */
export function NotificationSettings({ settings, onChange }: NotificationSettingsProps) {
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(notificationPermission());

  const granted = permission === "granted";
  const denied = permission === "denied";

  const enable = async () => {
    setPermission(await requestNotificationPermission());
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Desktop notification settings"
          title="Desktop notifications"
          className="h-8 w-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Settings className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Desktop notifications
        </div>
        {!supported ? (
          <p className="text-[12px] text-muted-foreground">
            This browser doesn’t support notifications.
          </p>
        ) : (
          <>
            {!granted && (
              <button
                type="button"
                onClick={enable}
                disabled={denied}
                className={cn(
                  "mb-3 inline-flex h-8 w-full items-center justify-center rounded-md border border-primary bg-primary px-3 text-[12.5px] font-medium text-primary-foreground",
                  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  "disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer",
                )}
              >
                {denied ? "Blocked in browser settings" : "Enable notifications"}
              </button>
            )}
            <div className="flex flex-col gap-2.5">
              <Toggle
                label="On run failure"
                checked={settings.failure}
                onChange={(v) => onChange({ ...settings, failure: v })}
              />
              <Toggle
                label="On OCR awaiting review"
                checked={settings.awaitingReview}
                onChange={(v) => onChange({ ...settings, awaitingReview: v })}
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Fires only when this tab is in the background.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
