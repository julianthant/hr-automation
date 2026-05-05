import type { IncomingMessage, ServerResponse } from "node:http";

export interface DashboardRouteContext {
  workflow: string;
  port: number;
  dir: string;
}

export type DashboardRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DashboardRouteContext,
) => boolean | void | Promise<boolean | void>;
