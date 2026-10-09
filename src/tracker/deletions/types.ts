export interface DeletionTarget {
  workflow: string;
  trackerDate: string;
  itemId: string;
  runId: string;
}

export interface DeletionManifest {
  deletionId: string;
  deletedAt: string;
  reason: string;
  targets: DeletionTarget[];
}

export function isDeletionManifest(value: unknown): value is DeletionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<DeletionManifest>;
  if (
    typeof manifest.deletionId !== "string" || manifest.deletionId.length === 0 ||
    typeof manifest.deletedAt !== "string" || !Number.isFinite(Date.parse(manifest.deletedAt ?? "")) ||
    typeof manifest.reason !== "string" || manifest.reason.length === 0 ||
    !Array.isArray(manifest.targets) || manifest.targets.length === 0
  ) return false;
  return manifest.targets.every((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const candidate = target as Partial<DeletionTarget>;
    return (
      typeof candidate.workflow === "string" && candidate.workflow.length > 0 &&
      typeof candidate.trackerDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.trackerDate) &&
      typeof candidate.itemId === "string" && candidate.itemId.length > 0 &&
      typeof candidate.runId === "string" && candidate.runId.length > 0
    );
  });
}
