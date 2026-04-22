/**
 * Registry of downloadable SharePoint spreadsheets.
 *
 * Single source of truth for both:
 *   - The dashboard queue-header download dropdown (populates via
 *     `GET /api/sharepoint-download/list`, one menu item per entry).
 *   - The backend `POST /api/sharepoint-download/run` handler (looks up the
 *     spec by `id`, reads `process.env[spec.envVar]`, downloads).
 *
 * Adding a new spreadsheet is a one-liner:
 *
 * ```ts
 * {
 *   id: "separations",
 *   label: "Separations roster",
 *   description: "Weekly separations tracking sheet",
 *   envVar: "SEPARATIONS_ROSTER_URL",
 * }
 * ```
 *
 * Don't forget to document the new env var in `.env.example`.
 */

export interface SharePointDownloadSpec {
  /**
   * Slug used in API paths + dropdown item keys. Must be URL-safe
   * (lowercase, hyphens only). Treated as an opaque string by the backend —
   * only the registry parses it.
   */
  id: string;
  /** Short human-readable name shown as the primary dropdown label. */
  label: string;
  /**
   * One-line subtext rendered under the label in the dropdown. Use it to
   * disambiguate when multiple spreadsheets serve overlapping purposes.
   */
  description?: string;
  /**
   * Name of the `process.env` variable holding the SharePoint URL. Each spec
   * owns its own env var so operators can configure only the spreadsheets
   * they actually use — missing env vars surface as a disabled dropdown
   * item (not a runtime error).
   */
  envVar: string;
  /**
   * Optional per-spec download directory, relative to `process.cwd()`.
   * Defaults to `src/data/` (see `buildSharePointRosterDownloadHandler`).
   * Override when a spreadsheet needs to land somewhere the rest of the
   * codebase already looks (e.g. a workflow-specific fixture dir).
   */
  outDir?: string;
}

/**
 * All available SharePoint download targets, in dropdown display order.
 *
 * Keep this list short. If it grows past ~6 entries consider grouping by
 * workflow (e.g. "Onboarding ▸ Roster", "Separations ▸ Weekly sheet") via
 * a new `group` field + Radix `DropdownMenuGroup` in the frontend.
 */
export const SHAREPOINT_DOWNLOADS: readonly SharePointDownloadSpec[] = [
  {
    id: "onboarding",
    label: "Onboarding roster",
    description: "New-hire spreadsheet used by onboarding + emergency-contact",
    envVar: "ONBOARDING_ROSTER_URL",
  },
] as const;

/**
 * Look up a spec by id. Returns `undefined` on miss — caller should translate
 * that into an HTTP 404 with a message that lists known ids.
 */
export function getDownloadSpec(id: string): SharePointDownloadSpec | undefined {
  return SHAREPOINT_DOWNLOADS.find((s) => s.id === id);
}

/**
 * All registered ids, for error messages and tests.
 */
export function listDownloadIds(): string[] {
  return SHAREPOINT_DOWNLOADS.map((s) => s.id);
}
