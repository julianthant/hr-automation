import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ActionPlan } from "../../src/ucpath/action-plan.js";
import { TransactionError } from "../../src/ucpath/types.js";

describe("ActionPlan", () => {
  describe("preview()", () => {
    it("prints header, step list, and footer without executing any function", () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      const executeFn = mock.fn(async () => {});
      const plan = new ActionPlan();
      plan.add("Navigate to Smart HR", executeFn);
      plan.add("Fill employee name", executeFn);
      plan.preview();

      console.log = originalLog;

      // Header and footer present
      assert.ok(logs.some((l) => l.includes("DRY RUN: Transaction Preview")));
      assert.ok(logs.some((l) => l.includes("No changes made to UCPath")));

      // Steps listed with numbering
      assert.ok(logs.some((l) => l.includes("1.") && l.includes("Navigate to Smart HR")));
      assert.ok(logs.some((l) => l.includes("2.") && l.includes("Fill employee name")));

      // Execute functions NOT called
      assert.equal(executeFn.mock.callCount(), 0);
    });

    it("prints header and footer only for empty plan", () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      const plan = new ActionPlan();
      plan.preview();

      console.log = originalLog;

      assert.ok(logs.some((l) => l.includes("DRY RUN: Transaction Preview")));
      assert.ok(logs.some((l) => l.includes("No changes made to UCPath")));
    });
  });

  describe("execute()", () => {
    it("calls each stored function in order, logging progress", async () => {
      const callOrder: number[] = [];
      const plan = new ActionPlan();

      plan.add("Step A", async () => { callOrder.push(1); });
      plan.add("Step B", async () => { callOrder.push(2); });
      plan.add("Step C", async () => { callOrder.push(3); });

      await plan.execute();

      assert.deepEqual(callOrder, [1, 2, 3]);
    });

    it("throws TransactionError with step name if any step throws", async () => {
      const plan = new ActionPlan();
      plan.add("Navigate to Smart HR", async () => {});
      plan.add("Fill form fields", async () => {
        throw new Error("Element not found");
      });

      await assert.rejects(
        () => plan.execute(),
        (err: unknown) => {
          assert.ok(err instanceof TransactionError);
          assert.equal(err.step, "Fill form fields");
          assert.ok(err.message.includes("Element not found"));
          return true;
        },
      );
    });

    it("completes without error for empty plan", async () => {
      const plan = new ActionPlan();
      await plan.execute(); // Should not throw
    });
  });

  describe("add()", () => {
    it("increments step counter for each added action", () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      const plan = new ActionPlan();
      plan.add("First", async () => {});
      plan.add("Second", async () => {});
      plan.add("Third", async () => {});
      plan.preview();

      console.log = originalLog;

      assert.ok(logs.some((l) => l.includes("1.") && l.includes("First")));
      assert.ok(logs.some((l) => l.includes("2.") && l.includes("Second")));
      assert.ok(logs.some((l) => l.includes("3.") && l.includes("Third")));
    });
  });
});
