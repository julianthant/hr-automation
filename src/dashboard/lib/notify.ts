import { toast as sonnerToast, type ExternalToast } from "sonner";

/**
 * Toast facade over sonner that bakes in the dashboard's toast *behaviour*
 * contract — the per-type durations and the title/description convention —
 * so every call site is consistent without repeating options.
 *
 * Design contract (see `src/dashboard/CLAUDE.md` toast lesson):
 *  - **Title** = the outcome ("Stopped daemon", "Couldn't delete batch").
 *  - **`description`** = the detail / why / next step (error reason, "moves to
 *    another daemon", `HTTP 500`).
 *  - **Duration by type** — success is a quick confirm; warnings need reading;
 *    errors linger so the operator actually sees them. A caller can always
 *    override `duration` per call (it wins over the default).
 *  - The visual treatment (per-type left accent bar, icon, close button, text
 *    hierarchy) is global — `<Toaster>` config in `App.tsx` + the
 *    `[data-sonner-toast]` rules in `index.css`. This module owns timing/copy
 *    only, never colours.
 *
 * Drop-in for sonner's `toast`: same call signatures, same return ids, so the
 * loading→result update pattern (`toast.loading(...)` → `toast.success(msg, {
 * id })`) keeps working. Migrated call sites import `toast` from here instead
 * of from `"sonner"`.
 */

/** Per-type auto-dismiss timing (ms). `loading` stays until explicitly updated. */
export const TOAST_DURATION = {
  success: 3000,
  info: 4000,
  warning: 6000,
  error: 8000,
} as const;

function withDuration(
  type: keyof typeof TOAST_DURATION,
  opts?: ExternalToast,
): ExternalToast {
  // Caller-supplied duration wins; otherwise apply the per-type default.
  return { duration: TOAST_DURATION[type], ...opts };
}

type ToastInput = Parameters<typeof sonnerToast>[0];

export const toast = Object.assign(
  (message: ToastInput, opts?: ExternalToast) => sonnerToast(message, opts),
  {
    success: (message: ToastInput, opts?: ExternalToast) =>
      sonnerToast.success(message, withDuration("success", opts)),
    info: (message: ToastInput, opts?: ExternalToast) =>
      sonnerToast.info(message, withDuration("info", opts)),
    warning: (message: ToastInput, opts?: ExternalToast) =>
      sonnerToast.warning(message, withDuration("warning", opts)),
    error: (message: ToastInput, opts?: ExternalToast) =>
      sonnerToast.error(message, withDuration("error", opts)),
    // Loading toasts persist until a follow-up update (success/error with the
    // same id) resolves them, so they keep sonner's Infinity default.
    loading: (message: ToastInput, opts?: ExternalToast) =>
      sonnerToast.loading(message, opts),
    message: sonnerToast.message,
    promise: sonnerToast.promise,
    custom: sonnerToast.custom,
    dismiss: sonnerToast.dismiss,
  },
);
