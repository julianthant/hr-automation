import { existsSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";

export type ScopeState =
  | { readonly state: "planned-absent"; readonly root: string; readonly files: readonly [] }
  | { readonly state: "active"; readonly root: string; readonly files: readonly string[] };

function walk(root: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, extensions));
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

/**
 * Resolve an activation-scoped file family without hiding an empty active root.
 * Absence is the only planned no-op; once the directory exists, zero matches
 * are a configuration error rather than a vacuous pass.
 */
export function resolveScopeFiles(
  root: string,
  extensions: readonly string[],
): ScopeState {
  if (!existsSync(root)) return { state: "planned-absent", root, files: [] };

  const files = walk(root, new Set(extensions));
  if (files.length === 0) {
    throw new Error(
      `Active rebuild scope resolved zero ${extensions.join("/")} files: ${root}`,
    );
  }
  return { state: "active", root, files };
}

export function isDirectExecution(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === new URL(`file://${resolve(entry)}`).href;
}
