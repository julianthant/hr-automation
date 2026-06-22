import type { WorkflowMetadata } from "../../core/kernel/types.js";
import type { NamingConfig, WorkflowOverride } from "../../domain/workflow-presentation/types.js";
import { mergePresentation } from "../../domain/workflow-presentation/resolve.js";
import { readOverride } from "./override-store.js";

/**
 * Pure: apply a (validated) override over base metadata. No fs.
 * Override null/undefined → base unchanged.
 */
export function applyOverride(
  meta: WorkflowMetadata,
  override: WorkflowOverride | null | undefined,
): WorkflowMetadata {
  if (!override) return meta;
  return {
    ...meta,
    label: override.label ?? meta.label,
    category: override.category ?? meta.category,
    iconName: override.iconName ?? meta.iconName,
    detailFields: override.detailFields ?? meta.detailFields,
    presets: override.presets ?? meta.presets,
    presentation: mergePresentation(meta.presentation, override.presentation),
  };
}

export function effectiveMetadata(meta: WorkflowMetadata, repoRoot: string): WorkflowMetadata {
  return applyOverride(meta, readOverride(repoRoot, meta.name));
}

export function effectiveNaming(meta: WorkflowMetadata, repoRoot: string): NamingConfig | undefined {
  return effectiveMetadata(meta, repoRoot).presentation.naming;
}
