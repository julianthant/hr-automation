import { Pencil } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Was this field blank on the paper form? Shared by every record view that
 * renders `RecordField` (oath + EC twins, extracted 2026-06-11).
 */
export function recordFieldMissing(
  record: { originallyMissing?: string[] | null },
  fieldKey: string,
): boolean {
  return record.originallyMissing?.includes(fieldKey) ?? false;
}

export function MissingFlag({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span title="Was blank on paper — please add to physical form" className="inline-flex">
      <Pencil className="h-3 w-3 text-warning" aria-hidden />
    </span>
  );
}

export function RecordField({
  label,
  missing,
  children,
}: {
  label: string;
  missing?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <MissingFlag visible={missing ?? false} />
      </span>
      {children}
    </label>
  );
}
