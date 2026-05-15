import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  if (metaUrl === `file://${invoked}`) return true;
  const modulePath = fileURLToPath(metaUrl);
  const moduleBase = basename(modulePath);
  return invoked === modulePath || invoked.endsWith(moduleBase) || invoked.endsWith(moduleBase.replace(/\.ts$/, ".js"));
}
