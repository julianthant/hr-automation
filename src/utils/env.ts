import { log } from "./log.js";

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
