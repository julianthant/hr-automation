import { DASHBOARD_INPUT_RUN_WORKFLOWS } from "../../domain/dashboard-run-surfaces.js";

type DashboardInputRunWorkflow = (typeof DASHBOARD_INPUT_RUN_WORKFLOWS)[number];

/**
 * Input-run registry — maps a workflow name to a text-box parser + UI
 * hints for the InputRunPanel's top-of-queue "Run" row. Workflows not in
 * this registry do not get a dashboard input-run affordance.
 *
 * Adding a workflow:
 *   1. Register its backend loader in `src/core/workflow-loaders.ts`
 *      (the dashboard's POST /api/enqueue uses that).
 *   2. Add an entry here with a `placeholder` and a `parseInput` that
 *      maps the operator's free-form text into typed workflow inputs.
 *   3. Add the workflow name to `DASHBOARD_INPUT_RUN_WORKFLOWS`.
 *      That's it — the InputRunPanel will appear automatically.
 *
 * Input-format conventions:
 *   - Comma-separated single-field workflows (separations / onboarding /
 *     oath-signature) use the `parseCommaSeparated` helper.
 *   - Workflows whose input contains commas (eid-lookup's "Last, First")
 *     should pick a different separator (newline / semicolon) in their
 *     parser.
 *   - Workflows needing structured multi-field input (work-study:
 *     emplId + date) should embed the shape into the parser — e.g.
 *     "10877384 04/23/2026, 10877384 04/24/2026".
 */

export interface InputRunParseOk {
  ok: true;
  inputs: Array<Record<string, unknown>>;
}
export interface InputRunParseErr {
  ok: false;
  error: string;
}
export type InputRunParseResult = InputRunParseOk | InputRunParseErr;

export interface InputRunConfig {
  /** Text shown inside the text box when it's empty. */
  placeholder: string;
  /**
   * Parse the operator's raw text into typed workflow inputs. Should
   * trim whitespace around separators, skip empties, and return a
   * clear error message on invalid input — the message surfaces
   * verbatim in the toast.
   */
  parseInput: (raw: string) => InputRunParseResult;
  /**
   * Optional: when set, clicking Run with an empty text box opens the
   * RunModal instead of being a no-op. Use for workflows whose Run
   * affordance has both an input-run path (typed IDs) and an
   * upload-run path (e.g. PDF → OCR → fan-out).
   */
  runEmptyAction?: {
    /** Pass-through to RunModal's `workflow` prop. */
    modalWorkflow: string;
    /** When `modalWorkflow === "ocr"`, pre-selects formType and hides the chooser. */
    lockedFormType?: string;
  };
}

/**
 * Comma-separated single-string-field parser. Splits on `,`, trims each
 * piece, drops empties, and maps each piece to `{ [fieldName]: value }`.
 * Used by separations (`docId`), onboarding (`email`), and
 * oath-signature (`emplId`) — any workflow whose Zod schema has exactly
 * one required string field AND whose values never contain commas.
 */
export function parseCommaSeparated(
  fieldName: string,
  validate?: { regex: RegExp; message: string },
) {
  return (raw: string): InputRunParseResult => {
    const pieces = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pieces.length === 0) {
      return { ok: false, error: `Enter at least one ${fieldName}` };
    }
    if (validate) {
      for (const v of pieces) {
        if (!validate.regex.test(v)) {
          return { ok: false, error: `${validate.message}: "${v}"` };
        }
      }
    }
    return {
      ok: true,
      inputs: pieces.map((value) => ({ [fieldName]: value })),
    };
  };
}

/**
 * Semicolon-separated single-string-field parser. Use when the value
 * itself may contain commas — e.g. eid-lookup takes `"Last, First"` name
 * strings, so the top-level separator must be `;`. Trims whitespace
 * around the semicolons (so `"Smith, John ; Doe, Jane"` is fine) and
 * drops empties.
 */
export function parseSemicolonSeparated(fieldName: string) {
  return (raw: string): InputRunParseResult => {
    const pieces = raw
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pieces.length === 0) {
      return { ok: false, error: `Enter at least one ${fieldName}` };
    }
    return {
      ok: true,
      inputs: pieces.map((value) => ({ [fieldName]: value })),
    };
  };
}

export function parsePersonLookupInputs(raw: string): InputRunParseResult {
  const pieces = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pieces.length === 0) {
    return { ok: false, error: "Enter at least one EID or name" };
  }
  return {
    ok: true,
    inputs: pieces.map((value) => {
      if (/^\d{5,}$/.test(value)) return { emplId: value };
      return { name: value };
    }),
  };
}

export const INPUT_RUN_REGISTRY: Record<DashboardInputRunWorkflow, InputRunConfig> = {
  separations: {
    placeholder: "Enter doc IDs, comma-separated (e.g. 3930, 3929)",
    parseInput: parseCommaSeparated("docId"),
  },
  "person-lookup": {
    placeholder: "Enter EIDs or names, semicolon-separated (e.g. 10873698; Battistessa, Johnnie)",
    parseInput: parsePersonLookupInputs,
  },
  "oath-signature": {
    placeholder: "Enter EIDs, comma-separated (e.g. 10873611, 10873075)",
    parseInput: parseCommaSeparated("emplId", {
      regex: /^\d{5,}$/,
      message: "EID must be numeric (5+ digits)",
    }),
    runEmptyAction: { modalWorkflow: "ocr", lockedFormType: "oath" },
  },
  "crm-doc-download": {
    placeholder: "Enter EIDs, comma-separated (e.g. 10873611, 10873075)",
    parseInput: parseCommaSeparated("emplId", {
      regex: /^\d{5,}$/,
      message: "EID must be numeric (5+ digits)",
    }),
  },
};

export function getInputRunConfig(workflow: string): InputRunConfig | undefined {
  return INPUT_RUN_REGISTRY[workflow as DashboardInputRunWorkflow];
}
