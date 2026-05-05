import type Database from "better-sqlite3";

export interface DashboardHonoDeps {
  dir: string;
  stateDb: Database.Database;
  workflow?: string;
  port?: number;
  projectionReady?: boolean;
  screenshotsDir?: string;
  staticDir?: string;
}

export function getDefaultWorkflow(deps: DashboardHonoDeps): string {
  return deps.workflow ?? "onboarding";
}
