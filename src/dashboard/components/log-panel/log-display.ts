import { getLogCategory } from "@/components/shared/types";

export interface LogDisplayLike {
  level: string;
  message: string;
}

export function isDebugLog(log: LogDisplayLike): boolean {
  return getLogCategory(log.level, log.message) === "debug";
}

export function formatLogMessageForDisplay(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "");
}

export function filterLogsForDebugVisibility<T extends LogDisplayLike>(
  logs: T[],
  showDebug: boolean,
): T[] {
  if (showDebug) return logs;
  return logs.filter((log) => !isDebugLog(log));
}
