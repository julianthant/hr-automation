/**
 * Quick-run registry — maps a workflow name to a text-box parser + UI
 * hints for the QuickRunPanel's top-of-queue "Run" row. Workflows not in
 * this registry have their Run row hidden.
 *
 * Adding a workflow:
 *   1. Register its backend loader in `src/core/workflow-loaders.ts`
 *      (the dashboard's POST /api/enqueue uses that).
 *   2. Add an entry here with a `placeholder` and a `parseInput` that
 *      maps the operator's free-form text into typed workflow inputs.
 *   3. That's it — the QuickRunPanel will appear automatically.
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

export interface QuickRunParseOk {
  ok: true;
  inputs: Array<Record<string, unknown>>;
}
export interface QuickRunParseErr {
  ok: false;
  error: string;
}
export type QuickRunParseResult = QuickRunParseOk | QuickRunParseErr;

export interface QuickRunConfig {
  /** Text shown inside the text box when it's empty. */
  placeholder: string;
  /**
   * Parse the operator's raw text into typed workflow inputs. Should
   * trim whitespace around separators, skip empties, and return a
   * clear error message on invalid input — the message surfaces
   * verbatim in the toast.
   */
  parseInput: (raw: string) => QuickRunParseResult;
}

/**
 * Comma-separated single-string-field parser. Splits on `,`, trims each
 * piece, drops empties, and maps each piece to `{ [fieldName]: value }`.
 * Used by separations (`docId`), onboarding (`email`), and
 * oath-signature (`emplId`) — any workflow whose Zod schema has exactly
 * one required string field.
 */
export function parseCommaSeparated(fieldName: string) {
  return (raw: string): QuickRunParseResult => {
    const pieces = raw
      .split(",")
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

export const QUICK_RUN_REGISTRY: Record<string, QuickRunConfig> = {
  separations: {
    placeholder: "Enter doc IDs, comma-separated (e.g. 3930, 3929)",
    parseInput: parseCommaSeparated("docId"),
  },
};

export function getQuickRunConfig(workflow: string): QuickRunConfig | undefined {
  return QUICK_RUN_REGISTRY[workflow];
}
