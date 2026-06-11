import { createCachedResource } from "./resource-factory";

export interface FormTypeOption {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
  /** Whether approving this form fans out downstream daemon rows. */
  hasApproveFanOut?: boolean;
}

/**
 * Module-level form-type cache shared across every consumer of `useFormTypes`.
 * Primed once at App mount via `prefetchFormTypes()` so RunModal's first paint
 * already has the picker — no "missing form type chooser" frame.
 *
 * Mirror of `useRosters` — same lifecycle, same staleness contract.
 */
const resource = createCachedResource<FormTypeOption[]>({
  fetcher: async () => {
    const resp = await fetch("/api/ocr/forms");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as FormTypeOption[];
  },
  fallback: [],
});

/**
 * Synchronous lookup against the module-level form-types cache: does this
 * form type fan out downstream rows on approve? Returns false when the cache
 * isn't primed yet (the pane re-renders when it loads). Used by the OCR review
 * pane to show the Approve button for fan-out forms on standalone runs.
 */
export function formTypeHasApproveFanOut(formType: string | undefined): boolean {
  if (!formType) return false;
  const cache = resource.peek();
  if (cache === null) return false;
  return cache.some((f) => f.formType === formType && f.hasApproveFanOut === true);
}

/** Kick off the form-types fetch eagerly. Call from App mount. Idempotent. */
export function prefetchFormTypes(): void {
  resource.prefetch();
}

/** Force a refetch. */
export function refreshFormTypes(): void {
  resource.refresh();
}

/** Subscribe to the form-types cache. Triggers a fetch if nothing is cached
 *  or in flight. Returns the current value (or `null` if not yet loaded). */
export function useFormTypes(): FormTypeOption[] | null {
  return resource.useResource();
}
