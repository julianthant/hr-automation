import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Thrown when private/, a file inside it, or a values.json key is missing. */
export class MissingPrivateDataError extends Error {
  constructor(ref: string) {
    super(`Missing private data: ${ref}`);
    this.name = "MissingPrivateDataError";
  }
}

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
      if (parsed.name === "hr-automation") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MissingPrivateDataError("private/");
}

let values: Record<string, string> | undefined;

function loadValues(): Record<string, string> {
  if (values) return values;
  const folder = path.join(repoRoot(), "private");
  if (!existsSync(folder)) throw new MissingPrivateDataError("private/");
  const file = path.join(folder, "values.json");
  if (!existsSync(file)) throw new MissingPrivateDataError("private/values.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  values = parsed;
  return parsed;
}

/** Real value for a stable key. The key is not the value. */
export function privateValue(key: string): string {
  const table = loadValues();
  if (!Object.prototype.hasOwnProperty.call(table, key)) throw new MissingPrivateDataError(key);
  return table[key];
}

/** Absolute path of a file under private/. Throws if the folder or file is missing. */
export function privateFile(relativePath: string): string {
  const folder = path.join(repoRoot(), "private");
  if (!existsSync(folder)) throw new MissingPrivateDataError("private/");
  const file = path.join(folder, relativePath);
  if (!existsSync(file)) throw new MissingPrivateDataError(path.posix.join("private", relativePath));
  return file;
}

export function privateJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(privateFile(relativePath), "utf8"));
}

const PRIVATE_TREE_FILES = new Set([
  "config/rebuild/legacy-change-accounting.json",
  "config/workflow-design/data-bank/index.json",
  "config/workflow-design/data-bank/raw/separations.json",
  "config/workflow-design/data-bank/raw/systems/i9.json",
  "config/workflow-design/data-bank/raw/workflows/onboarding.json",
  "config/workflow-design/data-bank/systems/i9.json",
  "config/workflow-design/data-bank/systems/new-kronos.json",
  "config/workflow-design/data-bank/workflows/onboarding.json",
  "config/workflow-design/data-bank/workflows/separations.json",
  "tests/fixtures/kronos-pay-rule/elections-tracker.csv",
]);

/** Files restored under private/ are read from there. Anything else stays where it is. */
export function readPrivateIfListed(absoluteFile: string): string {
  const rel = path.relative(repoRoot(), absoluteFile);
  if (PRIVATE_TREE_FILES.has(rel)) return privateFile(rel);
  return absoluteFile;
}
