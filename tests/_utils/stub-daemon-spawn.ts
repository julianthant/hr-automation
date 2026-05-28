/**
 * Shared daemon spawn stub for unit tests that exercise enqueue/retry paths
 * calling ensureDaemonsAvailable / ensureDaemonsAndEnqueue without launching
 * real cli-daemon subprocesses (which open Chrome login windows).
 */
import { createServer, type Server } from "node:http";
import {
  __resetDaemonSpawnLocksForTests,
  __setSpawnDaemonImplForTests,
} from "../../src/core/daemon/client.js";
import {
  ensureDaemonsDir,
  lockfilePath,
  writeLockfile,
} from "../../src/core/daemon/registry.js";

const activeServers: Server[] = [];

export type StubDaemonSpawnOptions = {
  /** Fixed lockfile instance id (default: incrementing `stub-1`, `stub-2`, …). */
  instanceId?: string;
  /** Prefix for auto-generated instance ids (default: `stub`). */
  instanceIdPrefix?: string;
};

export type StubDaemonSpawnHandle = {
  getSpawnCalls: () => number;
};

export function stubDaemonSpawn(
  trackerDir: string,
  opts: StubDaemonSpawnOptions = {},
): StubDaemonSpawnHandle {
  let spawnCalls = 0;
  ensureDaemonsDir(trackerDir);
  __setSpawnDaemonImplForTests(async (workflow, dir) => {
    spawnCalls++;
    const instanceId =
      opts.instanceId ??
      `${opts.instanceIdPrefix ?? "stub"}-${spawnCalls}`;
    const server = createServer((req, res) => {
      if (req.url === "/whoami" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workflow, instanceId, pid: process.pid, version: 1 }));
        return;
      }
      if (req.url === "/wake" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    activeServers.push(server);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const startedAt = new Date().toISOString();
    const path = lockfilePath(workflow, instanceId, dir);
    writeLockfile(
      { workflow, instanceId, pid: process.pid, port, startedAt, hostname: "host", version: 1 },
      path,
    );
    return { workflow, instanceId, pid: process.pid, port, startedAt, lockfilePath: path };
  });
  return { getSpawnCalls: () => spawnCalls };
}

export async function resetDaemonSpawnStubs(): Promise<void> {
  __setSpawnDaemonImplForTests(null);
  __resetDaemonSpawnLocksForTests();
  for (const server of activeServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
