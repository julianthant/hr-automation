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

export function validateI9Env(): { userId: string; password: string } {
  const hasI9UserId = Boolean(process.env.I9_USER_ID);
  const hasI9Password = Boolean(process.env.I9_PASSWORD);

  if (hasI9UserId || hasI9Password) {
    const required = ["I9_USER_ID", "I9_PASSWORD"] as const;
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      log.error(`Missing required .env variables: ${missing.join(", ")}`);
      log.error(
        "Set both I9_USER_ID and I9_PASSWORD, or omit both to reuse UCPath credentials.",
      );
      throw new EnvValidationError([...missing]);
    }

    return {
      userId: process.env.I9_USER_ID!,
      password: process.env.I9_PASSWORD!,
    };
  }

  return validateEnv();
}
