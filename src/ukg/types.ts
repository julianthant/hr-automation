export class UKGError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
  ) {
    super(message);
    this.name = "UKGError";
  }
}
