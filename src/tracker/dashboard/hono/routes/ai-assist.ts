import type { Hono } from "hono";

import { triageFailure } from "../../../../services/llm/triage.js";
import { sanityCheckRecord, inferRuleSpec, type CheckableRecord } from "../../../../services/llm/sanity-check.js";
import { suggestSelectors } from "../../../../services/llm/selector-suggest.js";
import { summarizeRun } from "../../../../services/llm/summarize-run.js";
import { buildTextPool, summarizeTextPool } from "../../../../services/llm/text-pool.js";
import { errorMessage } from "../../../../utils/errors.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

/**
 * On-demand LLM assist tools for the dashboard "AI Assist" settings section.
 * Each endpoint is a thin wrapper over a `services/llm` primitive — no run
 * state is read or written; the shared free-tier pool serves them with the same
 * rate-limit fall-through as OCR. A `null` primitive result (pool exhausted /
 * unusable reply) returns `{ ok: true, result: null }` so the UI can show a
 * clean "no result" rather than an error.
 */
export function registerAiAssistRoutes(app: Hono): void {
  // Report whether any provider keys are configured — lets the UI show a hint
  // instead of every tool silently returning null.
  app.get("/api/ai-assist/status", () => {
    const pool = buildTextPool();
    return jsonResponse({ ok: true, configured: pool.length > 0, pool: summarizeTextPool(pool) });
  });

  app.post("/api/ai-assist/triage", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 32_768);
      if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
      const body = parsed.body as { error?: string; workflow?: string; step?: string; systemId?: string };
      if (!body.error?.trim()) return jsonResponse({ ok: false, error: "error text is required" }, 400);
      const result = await triageFailure({
        rawError: body.error,
        workflow: body.workflow,
        step: body.step,
        systemId: body.systemId,
      });
      return jsonResponse({ ok: true, result });
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/ai-assist/sanity", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 32_768);
      if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
      const body = parsed.body as { record?: unknown; workflow?: string };
      if (!body.record || typeof body.record !== "object") {
        return jsonResponse({ ok: false, error: "record (a JSON object) is required" }, 400);
      }
      const record = flatten(body.record as Record<string, unknown>);
      const issues = await sanityCheckRecord(record, { rules: inferRuleSpec(record), workflow: body.workflow });
      return jsonResponse({ ok: true, result: { issues } });
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/ai-assist/selector", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 65_536);
      if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
      const body = parsed.body as { snapshot?: string; intent?: string; current?: string };
      if (!body.snapshot?.trim() || !body.intent?.trim()) {
        return jsonResponse({ ok: false, error: "snapshot and intent are required" }, 400);
      }
      const candidates = await suggestSelectors({ snapshot: body.snapshot, intent: body.intent, current: body.current });
      return jsonResponse({ ok: true, result: { candidates } });
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/ai-assist/summarize", async (c) => {
    try {
      const parsed = await readJsonRequest(c.req.raw, 65_536);
      if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
      const body = parsed.body as { logText?: string; workflow?: string };
      if (!body.logText?.trim()) return jsonResponse({ ok: false, error: "logText is required" }, 400);
      const result = await summarizeRun({ logText: body.logText, workflow: body.workflow });
      return jsonResponse({ ok: true, result });
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}

/** Flatten a nested object one+ levels into `a.b` dotted keys (values → strings). */
function flatten(obj: Record<string, unknown>, prefix = ""): CheckableRecord {
  const out: CheckableRecord = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else if (v == null) {
      out[key] = null;
    } else if (typeof v === "string") {
      out[key] = v;
    } else if (
      typeof v === "number" || typeof v === "boolean" ||
      typeof v === "bigint" || typeof v === "symbol"
    ) {
      out[key] = String(v);
    }
  }
  return out;
}
