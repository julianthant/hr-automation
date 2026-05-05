import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";

export interface DashboardRouteContext {
  workflow: string;
  port: number;
  dir: string;
  projectionReady?: boolean;
  stateDb?: Database.Database;
}

export type DashboardRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DashboardRouteContext,
) => boolean | void | Promise<boolean | void>;
