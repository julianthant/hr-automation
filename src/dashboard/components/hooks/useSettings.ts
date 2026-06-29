import { useCallback, useEffect, useState } from "react";

import {
  type CredentialStatus,
  type OperatorSettings,
  type OperatorSettingsOverride,
} from "../../../domain/settings/types.js";

interface SettingsResponse {
  ok: boolean;
  settings: OperatorSettings;
  override: OperatorSettingsOverride | null;
  credentials: CredentialStatus;
}

export interface UseSettings {
  /** Fully-merged settings (defaults + override), or null while loading. */
  settings: OperatorSettings | null;
  /** Read-only `.env` credential presence (booleans only). */
  credentials: CredentialStatus | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Persist a sparse override; returns true on success. */
  save: (override: OperatorSettingsOverride) => Promise<boolean>;
  /** Revert to all defaults (DELETE the override file). */
  reset: () => Promise<boolean>;
  /** Re-fetch from the server. */
  reload: () => void;
}

/**
 * Client hook over `/api/settings`. Loads the merged operator settings + the
 * read-only credential-presence flags on mount, and exposes `save` (POST a
 * sparse override) / `reset` (DELETE). Settings that drive backend constants
 * take effect on the next daemon spawn (the Settings page tells the operator
 * this); the hook just owns the fetch/persist round-trips.
 */
export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: SettingsResponse) => {
        if (cancelled) return;
        setSettings(body.settings);
        setCredentials(body.credentials);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const save = useCallback(async (override: OperatorSettingsOverride): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(override),
      });
      const body = (await res.json()) as { ok?: boolean; settings?: OperatorSettings; error?: unknown };
      if (res.ok && body.ok && body.settings) {
        setSettings(body.settings);
        setError(null);
        return true;
      }
      setError(typeof body.error === "string" ? body.error : "Save failed");
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const reset = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { method: "DELETE" });
      const body = (await res.json()) as { ok?: boolean; settings?: OperatorSettings };
      if (res.ok && body.ok && body.settings) {
        setSettings(body.settings);
        setError(null);
        return true;
      }
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { settings, credentials, loading, saving, error, save, reset, reload };
}
