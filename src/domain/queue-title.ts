export type QueueTitleKind = "single" | "batch" | "delegation";

export interface QueueTitle {
  kind: QueueTitleKind;
  title: string;
}

export function batchQueueTitle(label: string, runId: string): string {
  return `${label} · #${runId.slice(-4)}`;
}

export function queueTitleData(title: QueueTitle | null | undefined): Record<string, string> {
  if (!title?.title.trim()) return {};
  return {
    __queueTitle: title.title.trim(),
    __queueTitleKind: title.kind,
  };
}

export function rootQueueTitleData(title: string | undefined): Record<string, string> {
  const trimmed = title?.trim();
  if (!trimmed) return {};
  return {
    __queueTitle: trimmed,
    __queueTitleKind: "delegation",
    __queueRootTitle: trimmed,
    parentSubject: trimmed,
  };
}

export function readQueueTitle(data: Record<string, unknown> | null | undefined): string | undefined {
  const root = data?.__queueRootTitle;
  if (typeof root === "string" && root.trim()) return root.trim();
  const local = data?.__queueTitle;
  if (typeof local === "string" && local.trim()) return local.trim();
  return undefined;
}
