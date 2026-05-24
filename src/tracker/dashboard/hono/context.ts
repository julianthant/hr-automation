import { type Database } from "../../../infra/sqlite/index.js";
import { openStateDb } from "../../state/db.js";

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

export function getProjectionDb(deps: DashboardHonoDeps): Database | undefined {
  if (deps.projectionReady === false || !deps.stateDb) return undefined;
  return openStateDb(deps.dir);
}
