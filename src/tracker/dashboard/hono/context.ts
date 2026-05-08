import { type Database } from "../../../infra/sqlite/index.js";

export interface DashboardHonoDeps {
  dir: string;
  stateDb: Database;
  workflow?: string;
  port?: number;
  projectionReady?: boolean;
  screenshotsDir?: string;
  staticDir?: string;
}

export function getDefaultWorkflow(deps: DashboardHonoDeps): string {
  return deps.workflow ?? "onboarding";
}
