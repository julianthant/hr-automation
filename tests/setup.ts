import { beforeEach } from "node:test";

import { __resetAllDashboardCachesForTests } from "../src/tracker/test-caches.js";

beforeEach(() => {
  __resetAllDashboardCachesForTests();
});
