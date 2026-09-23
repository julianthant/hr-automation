import {
  DASHBOARD_INPUT_RUN_WORKFLOWS,
  DASHBOARD_UPLOAD_RUN_WORKFLOWS,
} from "../../domain/dashboard-run-surfaces.js";
import { parsePersonLookupMatchLine } from "../../workflows/person-lookup/schema.js";

type DashboardInputRunWorkflow = (typeof DASHBOARD_INPUT_RUN_WORKFLOWS)[number];
type DashboardUploadRunWorkflow = (typeof DASHBOARD_UPLOAD_RUN_WORKFLOWS)[number];

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
 *   - Workflows whose input contains commas (person-lookup's "Last, First")
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

export function applyInputRunOptions(
  inputs: Array<Record<string, unknown>>,
  options: { mode?: string; crmCheck?: boolean; dryRun?: boolean },
): Array<Record<string, unknown>> {
  return inputs.map((input) => ({
    ...input,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(typeof options.crmCheck === "boolean" ? { crmCheck: options.crmCheck } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  }));
}

export interface InputRunMode {
  /** Stable value folded onto each parsed input as `mode`. */
  key: string;
  /** Short operator-facing label for the segmented mode picker. */
  label: string;
  /** Mode-specific text-box hint. */
  placeholder: string;
  /** Mode-specific parser; owns the full typed-input shape. */
  parseInput: (raw: string) => InputRunParseResult;
  /** Short explanation rendered beside the picker. */
  note?: string;
  /** Semantic CRM default when this mode becomes active. */
  crmCheckDefault?: boolean;
}

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
   * Optional peer modes for one workflow. The first entry is the default.
   * InputRunPanel renders these generically and folds the selected `key` onto
   * every parsed input; workflow-specific branching belongs in this registry.
   */
  modes?: readonly InputRunMode[];
  /**
   * Where the mode picker renders. `inline` (default) — a segmented control
   * above the text box (person-lookup Search | Match, which also swaps the
   * parser/placeholder). `run-settings` — a radio section inside the gear
   * popover beside Workers / Dry run (onboarding Hire type: the modes share
   * one parser, so the picker is a run setting, not an input-shape switch).
   */
  modesPlacement?: "inline" | "run-settings";
  /** Section heading for the mode picker when it lives in run settings (e.g. "Hire type"). */
  modesLabel?: string;
  /** Surface the independent CRM-check toggle in run settings. */
  supportsCrmCheck?: boolean;
  /**
   * When true, the input-run panel surfaces a per-page-load **Dry run**
   * toggle in its run-settings gear. On submit it folds `dryRun: true`
   * onto every parsed input (the field rides `input_json` and is validated
   * by the workflow's Zod schema, which must declare an optional `dryRun`).
   * Use for workflows whose dry-run path skips an irreversible external
   * write (onboarding skips the UCPath Smart HR submit).
   */
  supportsDryRun?: boolean;
  /**
   * Optional: when set, clicking Run with an empty text box opens the
   * RunModal instead of being a no-op. Use for workflows whose Run
   * affordance has both an input-run path (typed IDs) and an
   * upload-run path (e.g. PDF → OCR → fan-out).
   */
  runEmptyAction?: {
    /**
     * Pass-through to RunModal's `workflow` prop — must be an upload-run
     * workflow. The modal's own registry entry owns any locked formType.
     */
    modalWorkflow: DashboardUploadRunWorkflow;
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
 * itself may contain commas — e.g. person-lookup takes `"Last, First"` name
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

/** Parse semicolon-delimited Person Lookup Match records. */
export function parsePersonLookupMatchInputs(raw: string): InputRunParseResult {
  const pieces = raw
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  if (pieces.length === 0) {
    return { ok: false, error: "Enter at least one person to match" };
  }

  const inputs: Array<Record<string, unknown>> = [];
  for (const value of pieces) {
    try {
      inputs.push(parsePersonLookupMatchLine(value));
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true, inputs };
}

/**
 * Process exactly one roster table per run — either a worksheet label inside
 * the newest local onboarding `.xlsx`, or the full path to a roster file the
 * operator downloaded themselves (`.csv` has one table, so no label applies).
 * The two are told apart by shape: a path has a separator or a known extension,
 * a worksheet label has neither.
 */
export function parseProcessEidSheet(raw: string): InputRunParseResult {
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value) {
    return {
      ok: false,
      error: "Enter a roster worksheet label, or the full path to a roster .xlsx/.csv",
    };
  }
  const looksLikePath = value.includes("/") || /\.(?:csv|xlsx)$/i.test(value);
  if (!looksLikePath) {
    return { ok: true, inputs: [{ source: "roster-sheet", sheet: value }] };
  }
  if (!/\.(?:csv|xlsx)$/i.test(value)) {
    return { ok: false, error: "A roster path must end in .csv or .xlsx" };
  }
  return { ok: true, inputs: [{ source: "roster-sheet", rosterPath: value }] };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * crm-doc-download takes either an EID or an email per record (the
 * workflow's Zod schema and `inputSubject` already accept both, keyed on
 * which field is populated). Both values are comma-safe — EIDs are digits
 * and emails contain no commas — so we split on `,` and discriminate each
 * piece: numeric (5+ digits) → `{ emplId }`, valid email → `{ email }`.
 * Anything else is rejected with the offending token so the toast is
 * actionable.
 */
export function parseCrmDocDownloadInputs(raw: string): InputRunParseResult {
  const pieces = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pieces.length === 0) {
    return { ok: false, error: "Enter at least one EID or email" };
  }
  const inputs: Array<Record<string, unknown>> = [];
  for (const value of pieces) {
    if (/^\d{5,}$/.test(value)) {
      inputs.push({ emplId: value });
    } else if (EMAIL_RE.test(value)) {
      inputs.push({ email: value });
    } else {
      return {
        ok: false,
        error: `Expected an EID (5+ digits) or email: "${value}"`,
      };
    }
  }
  return { ok: true, inputs };
}

const ONBOARDING_PLACEHOLDER = "Enter emails, comma-separated (e.g. jdoe@ucsd.edu, asmith@ucsd.edu)";
// Comma-separated emails → a `pool` batch (onboarding declares
// `batch: { mode: "pool" }`). The regex catches obviously-malformed input
// before enqueue; the workflow's Zod `z.string().email()` is the
// authoritative check at claim time.
const parseOnboardingEmails = parseCommaSeparated("email", {
  regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  message: "Must be a valid email address",
});

export const INPUT_RUN_REGISTRY: Record<DashboardInputRunWorkflow, InputRunConfig> = {
  separations: {
    placeholder: "Enter doc IDs, comma-separated (e.g. 3930, 3929)",
    parseInput: parseCommaSeparated("docId"),
    // Dry run skips BOTH irreversible writes — the UCPath Smart HR submit and
    // the Kuali finalization save (see `separations/workflow.ts` dry-run
    // terminal). The toggle folds `dryRun: true` onto every parsed docId; the
    // workflow's Zod schema declares the optional `dryRun` that validates it.
    supportsDryRun: true,
  },
  "person-lookup": {
    placeholder: "Enter EIDs or names, semicolon-separated (e.g. 10873698; Battistessa, Johnnie)",
    parseInput: parsePersonLookupInputs,
    supportsCrmCheck: true,
    modes: [
      {
        key: "search",
        label: "Search",
        placeholder:
          "Enter EIDs or names, semicolon-separated (e.g. 10873698; Battistessa, Johnnie)",
        parseInput: parsePersonLookupInputs,
        note: "Person Org search; CRM check is on by default.",
        crmCheckDefault: true,
      },
      {
        key: "match",
        label: "Match",
        placeholder:
          "Last, First, DOB, SSN; use x when DOB or SSN is unavailable",
        parseInput: parsePersonLookupMatchInputs,
        note: "HR-Tasks rehire match; CRM check is off by default.",
        crmCheckDefault: false,
      },
    ],
  },
  "process-eid": {
    placeholder:
      "Roster worksheet label (e.g. Onboarding) or a full path to a roster .xlsx/.csv",
    parseInput: parseProcessEidSheet,
  },
  "oath-signature": {
    placeholder: "Enter EIDs, comma-separated (e.g. 10873611, 10873075)",
    parseInput: parseCommaSeparated("emplId", {
      regex: /^\d{5,}$/,
      message: "EID must be numeric (5+ digits)",
    }),
    runEmptyAction: { modalWorkflow: "oath-signature" },
  },
  "crm-doc-download": {
    placeholder: "Enter EIDs or emails, comma-separated (e.g. 10873611, jdoe@ucsd.edu)",
    parseInput: parseCrmDocDownloadInputs,
  },
  onboarding: {
    placeholder: ONBOARDING_PLACEHOLDER,
    parseInput: parseOnboardingEmails,
    supportsDryRun: true,
    // Hire type — folded onto every parsed input as `mode` (validated by the
    // workflow's Zod `mode` enum; omitted ⇒ new-hire). "Rehire" = the person
    // already exists in UCPath: no I-9, UC_CONC_HIRE concurrent hire on the
    // matched Empl ID (2026-08-21). Lives in the run-settings gear beside
    // Workers / Dry run (operator ask 2026-08-21), not as a row above the box.
    modesPlacement: "run-settings",
    modesLabel: "Hire type",
    modes: [
      {
        key: "new-hire",
        label: "New hire",
        placeholder: ONBOARDING_PLACEHOLDER,
        parseInput: parseOnboardingEmails,
        note: "Creates the I-9 profile, then files the UC_FULL_HIRE Smart HR hire.",
      },
      {
        key: "rehire",
        label: "Rehire",
        placeholder: ONBOARDING_PLACEHOLDER,
        parseInput: parseOnboardingEmails,
        note: "Existing UCPath person: skips the I-9 and files a UC_CONC_HIRE concurrent hire on their Empl ID.",
      },
    ],
  },
  "kronos-pay-rule": {
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
