import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function rewriteJsonlFile(
  path: string,
  keepPredicate: (row: Record<string, unknown>) => boolean,
): void {
  if (!existsSync(path)) return;
  const kept: string[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (keepPredicate(row)) kept.push(line);
    } catch {
      kept.push(line);
    }
  }
  writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
}
