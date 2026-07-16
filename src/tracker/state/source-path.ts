import { resolve } from "node:path";

/** Canonical identity used by projection/source-generation uniqueness keys. */
export function canonicalSourcePath(path: string): string {
  return resolve(path);
}
