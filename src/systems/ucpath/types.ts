export interface TransactionResult {
  success: boolean;
  error?: string;
  transactionId?: string;
  transactionNumber?: string;
}

export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
  ) {
    super(message);
    this.name = "TransactionError";
  }
}

export interface PlannedAction {
  step: number;
  description: string;
  execute: () => Promise<void>;
}
