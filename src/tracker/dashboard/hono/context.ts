import { type Database } from "../../../infra/sqlite/index.js";
import { openStateDb } from "../../state/db.js";
import type { DashboardAccessPolicy } from "./security.js";

export interface DashboardHonoDeps {
  dir: string;
  stateDb: Database;
  workflow?: string;
  port?: number;
  projectionReady?: boolean;
  screenshotsDir?: string;
  staticDir?: string;
  /** Repo root for the workflow-presentation override store (`<root>/config/workflow-presentation/*.json`). Defaults to `process.cwd()` at the call site. */
  repoRoot?: string;
  /** Present on real servers; omitted by focused route-unit tests. */
  accessPolicy?: DashboardAccessPolicy;
}

export function getDefaultWorkflow(deps: DashboardHonoDeps): string {
  return deps.workflow ?? "onboarding";
}

export function getProjectionDb(deps: DashboardHonoDeps): Database | undefined {
  if (deps.projectionReady === false || !deps.stateDb) return undefined;
  return openStateDb(deps.dir);
}
