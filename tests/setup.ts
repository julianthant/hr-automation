import { beforeEach } from "vitest";

import { __resetAllDashboardCachesForTests } from "../src/tracker/test-caches.js";

beforeEach(() => {
  __resetAllDashboardCachesForTests();
});
