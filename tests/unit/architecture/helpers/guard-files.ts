import { existsSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

export const REPO_ROOT = process.cwd();

export interface WalkFilesOptions {
  readonly extensions?: readonly string[];
  readonly missing?: "error" | "planned-empty";
}

/**
 * Deterministic recursive file walk shared by architecture guards.
 *
 * Missing roots fail by default. The only permitted soft-missing mode is the
 * explicitly named pre-activation state used while `temp_src` does not yet
 * exist; callers must still prove non-vacuity once that root is activated.
 */
export function walkFiles(
  root: string,
  options: WalkFilesOptions = {},
): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  if (!existsSync(root)) {
    if (options.missing === "planned-empty") return [];
    throw new Error(`Architecture guard scan root does not exist: ${root}`);
  }

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, options));
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

export function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

export interface CountAllowlistEntry {
  readonly count: number;
  readonly reason: string;
}

export type CountAllowlist = Readonly<Record<string, CountAllowlistEntry>>;

export interface CountAllowlistMessages {
  readonly unallowlisted: (file: string, count: number) => string;
  readonly changed: (file: string, expected: number, actual: number) => string;
  readonly stale: (file: string, expected: number) => string;
}

/** Fail-both-ways audit for the architecture suite's reviewed count ratchets. */
export function auditCountAllowlist(
  found: ReadonlyMap<string, number>,
  allowlist: CountAllowlist,
  messages: CountAllowlistMessages,
): string[] {
  const violations: string[] = [];

  for (const [file, count] of found) {
    const entry = allowlist[file];
    if (!entry) {
      violations.push(messages.unallowlisted(file, count));
      continue;
    }
    if (entry.count !== count) {
      violations.push(messages.changed(file, entry.count, count));
    }
  }

  for (const [file, entry] of Object.entries(allowlist)) {
    if (!found.has(file)) violations.push(messages.stale(file, entry.count));
    if (!entry.reason.trim()) {
      violations.push(`${file}: allowlist reason must be non-empty.`);
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      violations.push(`${file}: allowlist count must be a positive integer.`);
    }
  }

  return violations;
}
