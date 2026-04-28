import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * YYYY-MM-DD in the browser's local timezone. Mirrors the backend's
 * `dateLocal()` so tracker-file naming, the date picker, and SSE date
 * params all share the same day boundary (local midnight).
 */
export function dateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
