import { useCallback, useEffect, useState } from "react";
import type { WorkflowMetadata } from "../../lib/workflows-context.js";
import type { WorkflowOverride } from "../../../domain/workflow-presentation/types.js";
import type { SchemeMeta } from "../../../domain/workflow-presentation/schemes.js";
import type { DisplayStep } from "../../../domain/workflow-presentation/step-display.js";

export type { WorkflowOverride };

export interface WorkflowListEntry {
  name: string;
  label: string;
  hasOverride: boolean;
}

export interface SchemeLibrary {
  title: SchemeMeta[];
  subtitle: SchemeMeta[];
  trace: SchemeMeta[];
}

export interface WorkflowPresentationDetail {
  ok: true;
  base: WorkflowMetadata;
  effective: WorkflowMetadata;
  override: WorkflowOverride | null;
  schemeLibrary: SchemeLibrary;
}

export interface PreviewSample {
  title: string;
  subtitle?: string;
  steps: DisplayStep[];
}

export interface PreviewResult {
  ok: true;
  effective: WorkflowMetadata;
  sample: PreviewSample;
}

export function useWorkflowPresentation(): {
  list: WorkflowListEntry[];
  selected: string | null;
  load: (name: string) => void;
  data: WorkflowPresentationDetail | null;
  saving: boolean;
  save: (ov: WorkflowOverride) => Promise<boolean>;
  preview: (ov: WorkflowOverride) => Promise<void>;
  previewResult: PreviewResult | null;
  revert: () => Promise<boolean>;
} {
  const [list, setList] = useState<WorkflowListEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<WorkflowPresentationDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);

  useEffect(() => {
    fetch("/api/workflow-presentation")
      .then((r) => r.json())
      .then((b: { ok?: boolean; workflows?: WorkflowListEntry[] }) => {
        if (b.ok) setList(b.workflows ?? []);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback((name: string) => {
    setSelected(name);
    fetch(`/api/workflow-presentation/${name}`)
      .then((r) => r.json())
      .then((b: WorkflowPresentationDetail | { ok?: false }) => {
        if (b.ok) setData(b as WorkflowPresentationDetail);
      })
      .catch(() => undefined);
  }, []);

  const preview = useCallback(
    async (ov: WorkflowOverride) => {
      if (!selected) return;
      try {
        const r = await fetch(`/api/workflow-presentation/${selected}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ov),
        });
        const b: PreviewResult | { ok?: false } = await r.json();
        setPreviewResult(b.ok ? (b as PreviewResult) : null);
      } catch {
        setPreviewResult(null);
      }
    },
    [selected],
  );

  const save = useCallback(
    async (ov: WorkflowOverride): Promise<boolean> => {
      if (!selected) return false;
      setSaving(true);
      try {
        const r = await fetch(`/api/workflow-presentation/${selected}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ov),
        });
        const b: { ok?: boolean } = await r.json();
        if (b.ok) load(selected);
        return Boolean(b.ok);
      } catch {
        return false;
      } finally {
        setSaving(false);
      }
    },
    [selected, load],
  );

  const revert = useCallback(async (): Promise<boolean> => {
    if (!selected) return false;
    try {
      const r = await fetch(`/api/workflow-presentation/${selected}`, { method: "DELETE" });
      const ok = r.ok;
      if (ok) load(selected);
      return ok;
    } catch {
      return false;
    }
  }, [selected, load]);

  return { list, selected, load, data, saving, save, preview, previewResult, revert };
}
