import type { MiddlewareHandler } from "hono";

import { readOperatorSettingsFileState } from "../../settings/store.js";
import { jsonResponse } from "./responses.js";

const SAFE_CONTROL_MUTATIONS = new Set([
  "DELETE /api/settings",
  "POST /api/settings",
  "POST /api/settings/recover",
  "POST /api/delete-entry",
  "POST /api/delete-bulk",
  "POST /api/cancel-queued",
  "POST /api/cancel-running",
  "POST /api/cancel-active-bulk",
  "POST /api/daemon/stop",
  "POST /api/daemon/stop-instance",
  "POST /api/daemons/stop",
  "POST /api/worker/drain",
  "POST /api/worker/stop",
  "POST /api/browser/kill",
  "POST /api/ocr/discard-prepare",
  "POST /api/oath-upload/cancel",
  "POST /api/eid-approval/dismiss",
  "POST /api/capture/delete-photo",
  "POST /api/capture/discard",
]);

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Keep the dashboard's repair and shutdown controls usable while preventing a
 * corrupt settings file from launching or redirecting real workflow work.
 * Phone Capture may keep collecting/editing photos, but finalization is the
 * point that hands bytes back to an operator workflow and is therefore gated.
 */
export function configurationFaultMiddleware(
  repoRoot: string,
  options: { publicCapture?: boolean } = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (!isMutation(c.req.method)) return next();
    if (options.publicCapture && c.req.path !== "/api/capture/finalize") {
      return next();
    }
    const key = `${c.req.method} ${c.req.path}`;
    if (!options.publicCapture && SAFE_CONTROL_MUTATIONS.has(key)) return next();

    const state = readOperatorSettingsFileState(repoRoot);
    if (state.state !== "fault") return next();
    return jsonResponse(
      {
        ok: false,
        configurationFault: true,
        error: "Workflow mutations are blocked until operator settings are repaired or reset",
      },
      503,
    );
  };
}
