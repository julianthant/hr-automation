import { useEffect, useState } from "react";
import type { CaptureRegistration } from "../capture-types";

/**
 * Looks up a workflow's capture registration. Returns null if the
 * workflow has not registered a capture handler — callers use that as
 * the gate for hiding the Capture button.
 *
 * The registry endpoint (`GET /api/capture/registry`) returns metadata
 * for every workflow that has called `captureRegistry.register({...})`
 * server-side. Result is cached for the life of the page; capture
 * handlers register at module-load and don't change at runtime.
 */

interface RegistryResponse {
  [workflow: string]: { label: string; contextHints?: string[] };
}

let cachedRegistry: RegistryResponse | null = null;
let pendingFetch: Promise<RegistryResponse> | null = null;

function loadRegistry(): Promise<RegistryResponse> {
  if (cachedRegistry) return Promise.resolve(cachedRegistry);
  if (pendingFetch) return pendingFetch;
  pendingFetch = fetch("/api/capture/registry")
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => {
      cachedRegistry = (data ?? {}) as RegistryResponse;
      pendingFetch = null;
      return cachedRegistry;
    })
    .catch(() => {
      pendingFetch = null;
      return {} as RegistryResponse;
    });
  return pendingFetch;
}

export function useCaptureRegistration(workflow: string): CaptureRegistration | null {
  const [registration, setRegistration] = useState<CaptureRegistration | null>(() => {
    if (cachedRegistry?.[workflow]) {
      const entry = cachedRegistry[workflow];
      return { workflow, label: entry.label, contextHints: entry.contextHints };
    }
    return null;
  });

  useEffect(() => {
    let cancelled = false;
    loadRegistry().then((data) => {
      if (cancelled) return;
      const entry = data[workflow];
      setRegistration(
        entry ? { workflow, label: entry.label, contextHints: entry.contextHints } : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [workflow]);

  return registration;
}

/**
 * Test/dev helper — clears the module-level cache so a refreshing
 * dashboard tab picks up newly-registered workflows without a hard
 * reload. Not used in production paths.
 */
export function __resetCaptureRegistrationCache(): void {
  cachedRegistry = null;
  pendingFetch = null;
}
