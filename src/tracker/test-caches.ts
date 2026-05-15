import { __resetParseCacheForTests } from "./jsonl.js";
import { __resetSessionStateCacheForTests } from "./dashboard/hono/topics-emitters.js";
import { __resetPreflightThrottleForTests } from "./dashboard/hono/routes/base.js";
import { __resetCrossWorkflowCountsCacheForTests } from "./dashboard/hono/routes/entries-payload.js";

export function __resetAllDashboardCachesForTests(): void {
  __resetParseCacheForTests();
  __resetSessionStateCacheForTests();
  __resetPreflightThrottleForTests();
  __resetCrossWorkflowCountsCacheForTests();
}
