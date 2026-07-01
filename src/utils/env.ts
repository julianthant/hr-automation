import { log } from "./log.js";

/**
 * Read a numeric env var, falling back to `fallback` when unset/blank/invalid.
 * Used by core modules to make a hardcoded constant operator-tunable via the
 * settings store (which populates the env var only for an explicitly-set field —
 * see `applyOperatorSettingsEnv`). When the var is unset (the normal case AND
 * when the operator hasn't chosen) the result equals the original literal, so an
 * unconfigured install is behavior-neutral.
 */
export function numEnv(
  key: string,
  fallback: number,
  opts?: { integer?: boolean; min?: number },
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (opts?.integer && !Number.isInteger(n)) return fallback;
  if (opts?.min !== undefined && n < opts.min) return fallback;
  return n;
}

export class EnvValidationError extends Error {
  constructor(missing: string[]) {
    const msg = `Missing required .env variables: ${missing.join(", ")}. Create a .env file with these variables. See .env.example`;
    super(msg);
    this.name = "EnvValidationError";
  }
}

export function validateEnv(): { userId: string; password: string } {
  const required = ["UCPATH_USER_ID", "UCPATH_PASSWORD"] as const;
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    log.error(`Missing required .env variables: ${missing.join(", ")}`);
    log.error(
      "Create a .env file with these variables. See .env.example",
    );
    throw new EnvValidationError([...missing]);
  }

  return {
    userId: process.env.UCPATH_USER_ID!,
    password: process.env.UCPATH_PASSWORD!,
  };
}
