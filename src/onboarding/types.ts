export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly failedFields?: string[],
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export type { EmployeeData } from "./schema.js";
