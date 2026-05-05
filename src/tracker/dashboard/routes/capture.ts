import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { readMultipart } from "../../multipart-helper.js";
import { buildOcrPrepareHandler } from "../../ocr-http.js";
import { log } from "../../../utils/log.js";
import {
  createSessionStore,
  handleStart as handleCaptureStart,
  handleManifest as handleCaptureManifest,
  handleUpload as handleCaptureUpload,
  handleDeletePhoto as handleCaptureDeletePhoto,
  handleReplacePhoto as handleCaptureReplacePhoto,
  handleReorder as handleCaptureReorder,
  handleExtend as handleCaptureExtend,
  handleValidate as handleCaptureValidate,
  handleFinalize as handleCaptureFinalize,
  handleDiscard as handleCaptureDiscard,
  pickLanIp,
  type CaptureSessionEvent,
  type CaptureSessionStore,
  type CapturedPhoto,
} from "../../../capture/index.js";
import type {
  CaptureSession,
  CaptureSessionState,
} from "../../../capture/sessions.js";

const captureStore: CaptureSessionStore = createSessionStore();
const CAPTURE_PHOTOS_DIR = ".tracker/captures";
const CAPTURE_UPLOADS_DIR = ".tracker/uploads";
const captureMobileHtmlPath = join(
  import.meta.dirname ?? ".",
  "../../../capture/mobile.html",
);
let captureMobileHtmlCache: string | undefined;

function getCaptureMobileHtml(): string {
  if (captureMobileHtmlCache !== undefined) return captureMobileHtmlCache;
  try {
    captureMobileHtmlCache = readFileSync(captureMobileHtmlPath, "utf-8");
  } catch {
    captureMobileHtmlCache = "<!DOCTYPE html><html><body>capture mobile UI not built</body></html>";
  }
  return captureMobileHtmlCache;
}

const heic2anyAssetPath = join(
  import.meta.dirname ?? ".",
  "../../../../node_modules/heic2any/dist/heic2any.min.js",
);
let heic2anyAssetCache: Buffer | undefined;

function getHeic2anyAsset(): Buffer | undefined {
  if (heic2anyAssetCache !== undefined) return heic2anyAssetCache;
  try {
    heic2anyAssetCache = readFileSync(heic2anyAssetPath);
  } catch {
    return undefined;
  }
  return heic2anyAssetCache;
}

const captureRegistrations: Record<
  string,
  { label: string; contextHints?: string[] }
> = {
  "oath-signature": { label: "Capture paper roster" },
};

interface CaptureSseClient {
  id: number;
  res: ServerResponse;
}

let nextCaptureSseClientId = 0;
const captureSseClients = new Set<CaptureSseClient>();

function serializeCaptureSession(
  s: CaptureSession,
): {
  sessionId: string;
  workflow: string;
  contextHint?: string;
  state: CaptureSessionState;
  createdAt: number;
  expiresAt: number;
  phoneConnectedAt: number | null;
  photos: CapturedPhoto[];
  pdfPath?: string;
} {
  return {
    sessionId: s.sessionId,
    workflow: s.workflow,
    contextHint: s.contextHint,
    state: s.state,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    phoneConnectedAt: s.phoneConnectedAt ?? null,
    photos: s.photos,
    ...(s.pdfPath ? { pdfPath: s.pdfPath } : {}),
  };
}

function captureSseFanOut(eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...captureSseClients]) {
    try {
      client.res.write(payload);
    } catch {
      captureSseClients.delete(client);
    }
  }
}

captureStore.subscribe((event: CaptureSessionEvent) => {
  captureSseFanOut("session-event", event);
});

const captureHeartbeatInterval = setInterval(() => {
  captureSseFanOut("heartbeat", { ts: Date.now() });
}, 15_000);
captureHeartbeatInterval.unref?.();

function makeCaptureFinalize(trackerDir: string) {
  return async (session: CaptureSession): Promise<void> => {
    if (!session.pdfPath) {
      log.warn(`[capture] finalize fired without a pdfPath (sessionId=${session.sessionId})`);
      return;
    }

    let formType: string;
    if (session.workflow === "oath-signature") {
      formType = "oath";
    } else if (session.workflow === "emergency-contact") {
      formType = "emergency-contact";
    } else if (session.workflow === "ocr" && session.formType) {
      formType = session.formType;
    } else {
      log.warn(
        `[capture] no finalize handler for workflow="${session.workflow}" — PDF saved at ${session.pdfPath}`,
      );
      return;
    }

    const handler = buildOcrPrepareHandler({ trackerDir });
    const rosterDirs = [
      resolve(process.cwd(), ".tracker/rosters"),
      resolve(process.cwd(), "src/data"),
    ];
    const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];
    let rosterPath: string | undefined;
    try {
      const files = readdirSync(rosterDir).filter((f) => f.endsWith(".xlsx"));
      if (files.length > 0) {
        rosterPath = resolve(rosterDir, files.sort().at(-1)!);
      }
    } catch {
      /* tolerate */
    }

    const pdfOriginalName = `capture-${session.sessionId.slice(0, 8)}.pdf`;
    const result = await handler({
      pdfPath: session.pdfPath,
      pdfOriginalName,
      formType,
      rosterMode: rosterPath ? "existing" : "download",
      rosterPath,
      sessionId: session.sessionId,
    });
    if (result.status !== 202) {
      log.warn(`[capture] ocr prepare failed (status ${result.status}): ${JSON.stringify(result.body)}`);
    }
  };
}

export function createCaptureRoutes(): DashboardRoute {
  return async (req, res, url, ctx) => {
    if (req.method === "POST" && url.pathname === "/api/capture/start") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await handleCaptureStart(
        {
          workflow: String(parsed.body.workflow ?? ""),
          contextHint: parsed.body.contextHint
            ? String(parsed.body.contextHint)
            : undefined,
        },
        {
          store: captureStore,
          lanIp: pickLanIp(),
          port: ctx.port,
          publicUrl: process.env.CAPTURE_PUBLIC_URL || undefined,
          onFinalize: makeCaptureFinalize(ctx.dir),
        },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/capture/")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(getCaptureMobileHtml());
      return true;
    }

    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/capture/manifest/")
    ) {
      const token = url.pathname.slice("/api/capture/manifest/".length);
      const ua = req.headers["user-agent"];
      const fwd = req.headers["x-forwarded-for"];
      const remoteIp =
        (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : undefined) ||
        req.socket?.remoteAddress ||
        undefined;
      const result = handleCaptureManifest(token, {
        store: captureStore,
        phoneInfo: {
          userAgent: typeof ua === "string" ? ua : undefined,
          ip: remoteIp,
        },
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/upload") {
      const token = url.searchParams.get("token") ?? "";
      const mp = await readMultipart(req, 11 * 1024 * 1024);
      if (!mp.ok) {
        writeJson(res, 400, { ok: false, error: mp.error });
        return true;
      }
      const file = mp.parsed.files["file"];
      if (!file) {
        writeJson(res, 400, { ok: false, error: "missing 'file' part" });
        return true;
      }
      const result = await handleCaptureUpload(
        { token, bytes: file.data, originalName: file.filename },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/delete-photo") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await handleCaptureDeletePhoto(
        {
          token: String(parsed.body.token ?? ""),
          index: Number(parsed.body.index),
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/finalize") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = await handleCaptureFinalize(
        { token: String(parsed.body.token ?? "") },
        {
          store: captureStore,
          photosDir: CAPTURE_PHOTOS_DIR,
          uploadsDir: CAPTURE_UPLOADS_DIR,
        },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/discard") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = handleCaptureDiscard(
        {
          sessionId: String(parsed.body.sessionId ?? ""),
          reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/capture/sessions") {
      writeJson(res, 200, captureStore.listAll().map(serializeCaptureSession));
      return true;
    }

    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/capture/photos/")
    ) {
      const rest = url.pathname.slice("/api/capture/photos/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const sessionIdRaw = decodeURIComponent(rest.slice(0, slash));
      const indexStr = rest.slice(slash + 1);
      if (!/^[a-f0-9-]{8,80}$/i.test(sessionIdRaw)) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const idx = Number(indexStr);
      if (!Number.isInteger(idx) || idx < 0) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const session = captureStore.getById(sessionIdRaw);
      if (!session) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const photo = session.photos.find((p) => p.index === idx);
      if (!photo) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const filePath = join(CAPTURE_PHOTOS_DIR, sessionIdRaw, photo.filename);
      let photoStat;
      try {
        photoStat = await statAsync(filePath);
      } catch {
        res.writeHead(404);
        res.end();
        return true;
      }
      res.writeHead(200, {
        "Content-Type": photo.mime,
        "Cache-Control": "no-cache, must-revalidate",
        "Content-Length": String(photoStat.size),
      });
      createReadStream(filePath).pipe(res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/replace-photo") {
      const mp = await readMultipart(req, 11 * 1024 * 1024);
      if (!mp.ok) {
        writeJson(res, 400, { ok: false, error: mp.error });
        return true;
      }
      const file = mp.parsed.files["file"];
      if (!file) {
        writeJson(res, 400, { ok: false, error: "missing 'file' part" });
        return true;
      }
      const token = mp.parsed.fields["token"] ?? "";
      const indexStr = mp.parsed.fields["index"];
      if (!token) {
        writeJson(res, 400, { ok: false, error: "missing 'token' field" });
        return true;
      }
      if (indexStr === undefined) {
        writeJson(res, 400, { ok: false, error: "missing 'index' field" });
        return true;
      }
      const idx = Number(indexStr);
      if (!Number.isInteger(idx) || idx < 0) {
        writeJson(res, 400, {
          ok: false,
          error: "'index' must be a non-negative integer",
        });
        return true;
      }
      const blurField = mp.parsed.fields["blurScore"];
      const blurScore =
        blurField !== undefined && blurField !== ""
          ? Number(blurField)
          : undefined;
      const result = await handleCaptureReplacePhoto(
        {
          token,
          index: idx,
          bytes: file.data,
          originalName: file.filename,
          ...(typeof blurScore === "number" && Number.isFinite(blurScore)
            ? { blurScore }
            : {}),
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/reorder") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = handleCaptureReorder(
        {
          token: String(parsed.body.token ?? ""),
          fromIndex: Number(parsed.body.fromIndex),
          toIndex: Number(parsed.body.toIndex),
        },
        { store: captureStore },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/extend") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const byMsRaw = parsed.body.byMs;
      const byMs =
        typeof byMsRaw === "number" && Number.isFinite(byMsRaw)
          ? byMsRaw
          : undefined;
      const result = handleCaptureExtend(
        {
          sessionId: String(parsed.body.sessionId ?? ""),
          ...(byMs !== undefined ? { byMs } : {}),
        },
        { store: captureStore },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/validate") {
      const parsed = await readJsonBody(req, 4096);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const result = handleCaptureValidate(
        { sessionId: String(parsed.body.sessionId ?? "") },
        { store: captureStore },
      );
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/capture/registry") {
      writeJson(res, 200, captureRegistrations);
      return true;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/capture/sessions/stream"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sessions = captureStore.listAll().map(serializeCaptureSession);
      res.write(
        `event: session-list\ndata: ${JSON.stringify({ sessions })}\n\n`,
      );
      const id = ++nextCaptureSseClientId;
      const client: CaptureSseClient = { id, res };
      captureSseClients.add(client);
      req.on("close", () => {
        captureSseClients.delete(client);
      });
      return true;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/capture-assets/heic2any.min.js"
    ) {
      const buf = getHeic2anyAsset();
      if (!buf) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          "heic2any not installed on dashboard host — run `npm install heic2any`",
        );
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(buf.length),
      });
      res.end(buf);
      return true;
    }

    return false;
  };
}
