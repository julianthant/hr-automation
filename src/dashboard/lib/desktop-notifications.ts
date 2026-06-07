/**
 * Web Notifications for the dashboard — fires an OS notification when a run
 * fails or an OCR run reaches "awaiting review", but only while the tab is
 * backgrounded (no spam while the operator is watching). Permission must be
 * requested from a user gesture (the settings popover), per browser policy.
 */

const SETTINGS_KEY = "dashboard.notifySettings";

export interface NotifySettings {
  /** Notify when a run fails. */
  failure: boolean;
  /** Notify when an OCR run is awaiting operator review. */
  awaitingReview: boolean;
}

const DEFAULT_SETTINGS: NotifySettings = { failure: true, awaitingReview: true };

export function readNotifySettings(): NotifySettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NotifySettings>;
    return {
      failure: parsed.failure !== false,
      awaitingReview: parsed.awaitingReview !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeNotifySettings(settings: NotifySettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : "denied";
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Fire a notification if supported, permitted, and the tab is hidden. The `tag`
 * coalesces repeats for the same row; `onClick` focuses the tab + selects.
 */
export function fireDesktopNotification(opts: {
  title: string;
  body: string;
  tag?: string;
  onClick?: () => void;
}): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* construction can throw on some platforms — never let it break streaming */
  }
}
