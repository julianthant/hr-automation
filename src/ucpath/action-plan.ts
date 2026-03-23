import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";
import type { PlannedAction } from "./types.js";
import { TransactionError } from "./types.js";

export class ActionPlan {
  private actions: PlannedAction[] = [];
  private stepCounter = 0;

  add(description: string, execute: () => Promise<void>): void {
    this.stepCounter++;
    this.actions.push({ step: this.stepCounter, description, execute });
  }

  preview(): void {
    log.step("=== DRY RUN: Transaction Preview ===");
    for (const action of this.actions) {
      log.step(`  ${action.step}. ${action.description}`);
    }
    log.step("=== No changes made to UCPath ===");
  }

  async execute(): Promise<void> {
    const total = this.actions.length;
    for (const action of this.actions) {
      log.step(`[${action.step}/${total}] ${action.description}`);
      try {
        await action.execute();
      } catch (err) {
        throw new TransactionError(errorMessage(err), action.description);
      }
    }
  }
}
