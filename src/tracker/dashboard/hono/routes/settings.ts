import type { Hono } from "hono";

import {
  mergeOperatorSettings,
  type CredentialStatus,
} from "../../../../domain/settings/types.js";
import { OperatorSettingsOverrideSchema } from "../../../settings/schema.js";
import {
  deleteOperatorSettings,
  readOperatorSettingsOverride,
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
    i9User: has("I9_USER_ID"),
    i9Password: has("I9_PASSWORD"),
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
    const override = readOperatorSettingsOverride(root);
    return jsonResponse({
      ok: true,
      settings: mergeOperatorSettings(override),
      override,
      credentials: credentialStatus(),
    });
  });

  app.post("/api/settings", async (c) => {
    const parsed = OperatorSettingsOverrideSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse({ ok: false, error: parsed.error.issues }, 400);
    }
    try {
      writeOperatorSettings(root, parsed.data);
      return jsonResponse({ ok: true, settings: mergeOperatorSettings(parsed.data) });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  });

  app.delete("/api/settings", () => {
    const reverted = deleteOperatorSettings(root);
    return jsonResponse({ ok: true, reverted, settings: mergeOperatorSettings(null) });
  });
}
