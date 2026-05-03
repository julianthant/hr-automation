import { useEffect, useState } from "react";

export interface FormTypeOption {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
}

/**
 * Module-level form-type cache shared across every consumer of `useFormTypes`.
 * Primed once at App mount via `prefetchFormTypes()` so RunModal's first paint
 * already has the picker — no "missing form type chooser" frame.
 *
 * Mirror of `useRosters` — same lifecycle, same staleness contract.
 */
let cache: FormTypeOption[] | null = null;
let inflight: Promise<FormTypeOption[]> | null = null;
const subscribers = new Set<(forms: FormTypeOption[] | null) => void>();

function notify(): void {
  for (const cb of subscribers) cb(cache);
}

async function fetchOnce(): Promise<FormTypeOption[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const resp = await fetch("/api/ocr/forms");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as FormTypeOption[];
      cache = data;
      return data;
    } catch {
      cache = [];
      return [];
    } finally {
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

/** Kick off the form-types fetch eagerly. Call from App mount. Idempotent. */
export function prefetchFormTypes(): void {
  if (cache !== null || inflight) return;
  void fetchOnce();
}

/** Force a refetch. */
export function refreshFormTypes(): void {
  inflight = null;
  void fetchOnce();
}

/** Subscribe to the form-types cache. Triggers a fetch if nothing is cached
 *  or in flight. Returns the current value (or `null` if not yet loaded). */
export function useFormTypes(): FormTypeOption[] | null {
  const [forms, setForms] = useState<FormTypeOption[] | null>(cache);

  useEffect(() => {
    subscribers.add(setForms);
    if (cache === null && !inflight) void fetchOnce();
    return () => {
      subscribers.delete(setForms);
    };
  }, []);

  return forms;
}
