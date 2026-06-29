import { useCallback, useEffect, useState } from "react";
import type { WorkflowDesignSpec } from "../../../domain/workflow-design/types.js";

export interface SavedDesignPaths {
  jsonPath: string;
  mdPath: string;
}

/**
 * Fetch/save the design-intent scaffold for a workflow. The spec's `generatedAt`
 * is stamped server-side, so the client may send a placeholder. Save returns the
 * written file paths so the UI can surface them.
 */
export function useWorkflowDesign(workflowName: string | null): {
  spec: WorkflowDesignSpec | null;
  loaded: boolean;
  saving: boolean;
  save: (spec: WorkflowDesignSpec) => Promise<SavedDesignPaths | null>;
  remove: () => Promise<boolean>;
} {
  const [spec, setSpec] = useState<WorkflowDesignSpec | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workflowName) {
      setSpec(null);
      setLoaded(false);
      return;
    }
    let live = true;
    setLoaded(false);
    fetch(`/api/workflow-design/${workflowName}`)
      .then((r) => r.json())
      .then((b: { ok?: boolean; spec?: WorkflowDesignSpec | null }) => {
        if (!live) return;
        setSpec(b.ok ? b.spec ?? null : null);
        setLoaded(true);
      })
      .catch(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [workflowName]);

  const save = useCallback(
    async (next: WorkflowDesignSpec): Promise<SavedDesignPaths | null> => {
      if (!workflowName) return null;
      setSaving(true);
      try {
        const r = await fetch(`/api/workflow-design/${workflowName}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        const b: { ok?: boolean; jsonPath?: string; mdPath?: string } = await r.json();
        if (b.ok && b.jsonPath && b.mdPath) {
          setSpec(next);
          return { jsonPath: b.jsonPath, mdPath: b.mdPath };
        }
        return null;
      } catch {
        return null;
      } finally {
        setSaving(false);
      }
    },
    [workflowName],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    if (!workflowName) return false;
    try {
      const r = await fetch(`/api/workflow-design/${workflowName}`, { method: "DELETE" });
      const ok = r.ok;
      if (ok) setSpec(null);
      return ok;
    } catch {
      return false;
    }
  }, [workflowName]);

  return { spec, loaded, saving, save, remove };
}
