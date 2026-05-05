import type { LogCategory, LogOccasion } from "../log-events.js";

export interface NotificationPolicyInput {
  category?: LogCategory;
  occasion?: LogOccasion;
}

export interface NotificationRoute {
  dashboardToast: boolean;
  telegram: boolean;
}

export function routeNotification(input: NotificationPolicyInput): NotificationRoute {
  if (input.category === "debug") return { dashboardToast: false, telegram: false };
  if (input.category === "auth" && input.occasion === "waiting") {
    return { dashboardToast: true, telegram: true };
  }
  if (input.category === "delegation" && input.occasion === "failed") {
    return { dashboardToast: true, telegram: true };
  }
  if (input.category === "operator" && input.occasion === "waiting") {
    return { dashboardToast: true, telegram: true };
  }
  return { dashboardToast: false, telegram: false };
}
