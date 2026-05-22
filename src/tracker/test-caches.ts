import { __resetParseCacheForTests } from "./jsonl.js";
import {
  __resetSessionStateCacheForTests,
  __resetEntriesPayloadCacheForTests,
} from "./dashboard/hono/topics-emitters.js";
import { __resetPreflightThrottleForTests } from "./dashboard/hono/routes/base.js";
import { __resetCrossWorkflowCountsCacheForTests } from "./dashboard/hono/routes/entries-payload.js";
import { __resetSessionEventsCacheForTests } from "./session-events.js";

export function __resetAllDashboardCachesForTests(): void {
  __resetParseCacheForTests();
  __resetSessionStateCacheForTests();
  __resetEntriesPayloadCacheForTests();
  __resetPreflightThrottleForTests();
  __resetCrossWorkflowCountsCacheForTests();
  __resetSessionEventsCacheForTests();
}
