import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { readMultipart } from "../../multipart-helper.js";
import {
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  buildOathUploadCancelHandler,
  saveUploadedPdf,
} from "../../oath-upload-http.js";

function createOathUploadHandlers(dir: string) {
  return {
    duplicateCheck: buildOathUploadDuplicateCheckHandler({ trackerDir: dir }),
    start: buildOathUploadStartHandler({ trackerDir: dir }),
    cancel: buildOathUploadCancelHandler({ trackerDir: dir }),
  };
}

export function createOathUploadRoutes(): DashboardRoute {
  let initializedForDir: string | null = null;
  let handlers: ReturnType<typeof createOathUploadHandlers> | null = null;

  return async (req, res, url, ctx) => {
    if (!url.pathname.startsWith("/api/oath-upload/")) return false;
    if (initializedForDir !== ctx.dir || !handlers) {
      handlers = createOathUploadHandlers(ctx.dir);
      initializedForDir = ctx.dir;
    }

    if (req.method === "GET" && url.pathname === "/api/oath-upload/check-duplicate") {
      const hash = url.searchParams.get("hash") ?? "";
      const lookbackDays = url.searchParams.get("lookbackDays")
        ? Number(url.searchParams.get("lookbackDays"))
        : undefined;
      const r = await handlers.duplicateCheck({ hash, lookbackDays });
      writeJson(res, r.status, r.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/oath-upload/cancel") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const r = await handlers.cancel({
        sessionId: String(parsed.body.sessionId ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
        reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
      });
      writeJson(res, r.status, r.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/oath-upload/start") {
      const mp = await readMultipart(req, 50 * 1024 * 1024);
      if (!mp.ok) {
        writeJson(res, 400, { ok: false, error: mp.error });
        return true;
      }
      const file = mp.parsed.files["pdf"];
      if (!file) {
        writeJson(res, 400, { ok: false, error: "missing 'pdf' file part" });
        return true;
      }

      const pdfPath = await saveUploadedPdf(file.data, file.filename ?? "upload.pdf", ctx.dir);
      const pdfHash = createHash("sha256").update(file.data).digest("hex");
      const sessionId = mp.parsed.fields["sessionId"]?.trim() || undefined;

      const rosterMode = (mp.parsed.fields["rosterMode"]?.trim() ?? "download") as "existing" | "download";
      let rosterPath: string | undefined;
      if (rosterMode === "existing") {
        const rosterDirs = [
          resolve(process.cwd(), ".tracker/rosters"),
          resolve(process.cwd(), "src/data"),
        ];
        const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];
        try {
          const files = readdirSync(rosterDir).filter((f) => f.endsWith(".xlsx"));
          if (files.length > 0) {
            rosterPath = resolve(rosterDir, files.sort().at(-1)!);
          }
        } catch {
          /* tolerate */
        }
      }

      const r = await handlers.start({
        pdfPath,
        pdfOriginalName: file.filename ?? "upload.pdf",
        pdfHash,
        sessionId,
        rosterMode,
        rosterPath,
      });
      writeJson(res, r.status, r.body);
      return true;
    }

    return false;
  };
}
