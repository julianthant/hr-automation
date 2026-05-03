import { z } from "zod";

/**
 * Input shape for the kernel `sharepoint-download` workflow. One run = one
 * file. The handler resolves the URL itself from `process.env[spec.envVar]`
 * via the registry — we accept the `url` here too so the kernel handler can
 * use it directly (and so tests can inject a fake URL without touching env).
 *
 * `id` is the dashboard/registry identifier (e.g. `"onboarding"`). `label`
 * is the human-readable spreadsheet name, mirrored into `detailFields` so
 * the queue row shows "Onboarding Roster" instead of the opaque id.
 * `outDir` is optional per-spec override; when absent, the handler defaults
 * to `<cwd>/src/data`.
 */
export const SharePointDownloadInputSchema = z.object({
  id: z.string().min(1, "id must not be empty"),
  label: z.string().min(1, "label must not be empty"),
  url: z.string().url("url must be a valid URL"),
  outDir: z.string().optional(),
  parentRunId: z.string().optional(),
  /** Optional saved-filename prefix; see `SharePointDownloadSpec.filenameBase`. */
  filenameBase: z.string().optional(),
});

export type SharePointDownloadInput = z.infer<typeof SharePointDownloadInputSchema>;
