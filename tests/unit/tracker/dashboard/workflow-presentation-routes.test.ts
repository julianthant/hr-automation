import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../../src/tracker/state/db.js";

let dir: string;
let repoRoot: string;
let app: ReturnType<typeof createDashboardHonoApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-pres-dir-"));
  repoRoot = mkdtempSync(join(tmpdir(), "wf-pres-root-"));
  app = createDashboardHonoApp({ dir, stateDb: openStateDb(dir), repoRoot });
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  if (repoRoot && existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
});

describe("workflow-presentation routes", () => {
  it("GET :workflow returns base + effective + schemeLibrary", async () => {
    const res = await app.request("/api/workflow-presentation/onboarding");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.effective.name).toBe("onboarding");
    expect(body.schemeLibrary.title.length).toBeGreaterThan(0);
  });

  it("POST invalid override → 400", async () => {
    const res = await app.request("/api/workflow-presentation/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        presentation: { naming: { title: { scheme: "bogus" }, subtitle: { scheme: "trace-only" } } },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST valid then GET reflects it; DELETE reverts", async () => {
    const ok = await app.request("/api/workflow-presentation/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "HC Onboarding" }),
    });
    expect(ok.status).toBe(200);
    const got = await (await app.request("/api/workflow-presentation/onboarding")).json();
    expect(got.effective.label).toBe("HC Onboarding");
    const del = await app.request("/api/workflow-presentation/onboarding", { method: "DELETE" });
    expect((await del.json()).reverted).toBe(true);
  });
});
