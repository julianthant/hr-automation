import { validateEnv } from "./utils/env.js";

export function requireEnv(): void {
  try {
    validateEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer (got "${value}")`);
  }
  return n;
}
