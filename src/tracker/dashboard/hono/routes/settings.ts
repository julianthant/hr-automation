import type { Hono } from "hono";

import {
  mergeOperatorSettings,
  type CredentialStatus,
} from "../../../../domain/settings/types.js";
import { OperatorSettingsOverrideSchema } from "../../../settings/schema.js";
import {
  deleteOperatorSettings,
  readOperatorSettingsFileState,
  recoverOperatorSettingsBackup,
  writeOperatorSettings,
} from "../../../settings/store.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

/** Presence of each `.env` credential — booleans ONLY, never the secret value. */
function credentialStatus(): CredentialStatus {
  const has = (key: string): boolean => Boolean(process.env[key]?.trim());
  return {
    ucpathUser: has("UCPATH_USER_ID"),
    ucpathPassword: has("UCPATH_PASSWORD"),
    timekeeperName: has("TIMEKEEPER_NAME"),
    onboardingRosterUrl: has("ONBOARDING_ROSTER_URL"),
  };
}

/**
 * `/api/settings` — read/write the operator-settings override
 * (`config/settings.json`). Mirrors the workflow-presentation routes:
 *
 *   GET    → { ok, settings (merged), override (sparse|null), credentials }
 *   POST   → validate (Zod, fail loud → 400) + persist the sparse override
 *   DELETE → revert to all defaults (remove the file)
 *
 * The response also carries read-only credential *presence* so the Settings page
 * can show which `.env` secrets are configured without ever exposing or editing
 * a password. Settings that change runtime constants take effect on the NEXT
 * daemon spawn (each daemon reads `config/settings.json` at process start); the
 * dashboard's own server reads them at boot, so a few backend constants need a
 * dashboard restart — the page surfaces that to the operator.
 */
export function registerSettingsRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const root = deps.repoRoot ?? process.cwd();

  app.get("/api/settings", () => {
    const fileState = readOperatorSettingsFileState(root);
    const override = fileState.state === "valid" ? fileState.override : null;
    return jsonResponse({
      ok: true,
      settings: fileState.state === "fault" ? null : mergeOperatorSettings(override),
      override,
      configuration: fileState,
      credentials: credentialStatus(),
    });
  });

  app.post("/api/settings", async (c) => {
    const parsed = OperatorSettingsOverrideSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse({ ok: false, error: parsed.error.issues }, 400);
    }
    try {
      const validated = writeOperatorSettings(root, parsed.data);
      return jsonResponse({ ok: true, settings: mergeOperatorSettings(validated) });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  });

  app.delete("/api/settings", () => {
    try {
      const reverted = deleteOperatorSettings(root);
      return jsonResponse({ ok: true, reverted, settings: mergeOperatorSettings(null) });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  });

  app.post("/api/settings/recover", () => {
    try {
      const recovered = recoverOperatorSettingsBackup(root);
      return jsonResponse({
        ok: true,
        settings: mergeOperatorSettings(recovered),
        override: recovered,
        configuration: { state: "valid", override: recovered },
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 409);
    }
  });
}
