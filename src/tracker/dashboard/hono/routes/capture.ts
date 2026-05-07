import { createReadStream } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";

import {
  handleDeletePhoto,
  handleDiscard,
  handleExtend,
  handleFinalize,
  handleManifest,
  handleReorder,
  handleReplacePhoto,
  handleStart,
  handleUpload,
  handleValidate,
  pickLanIp,
} from "../../../../services/capture/index.js";
import {
  CAPTURE_PHOTOS_DIR,
  CAPTURE_UPLOADS_DIR,
  captureRegistrations,
  captureStore,
  getCaptureMobileHtml,
  getHeic2anyAsset,
  makeCaptureFinalize,
  serializeCaptureSession,
} from "../../capture-state.js";
import type { DashboardHonoDeps } from "../context.js";
import { readMultipartRequest } from "../multipart.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerCaptureRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.post("/api/capture/start", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handleStart(
      {
        workflow: String(parsed.body.workflow ?? ""),
        contextHint: parsed.body.contextHint ? String(parsed.body.contextHint) : undefined,
      },
      {
        store: captureStore,
        lanIp: pickLanIp(),
        port: deps.port ?? 3838,
        publicUrl: process.env.CAPTURE_PUBLIC_URL || undefined,
        onFinalize: makeCaptureFinalize(deps.dir),
      },
    );
    return jsonResponse(result.body, result.status);
  });

  app.get("/capture/:token", () => {
    return new Response(getCaptureMobileHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/api/capture/manifest/:token", (c) => {
    const ua = c.req.header("user-agent");
    const forwarded = c.req.header("x-forwarded-for");
    const remoteIp = forwarded?.split(",")[0]?.trim();
    const result = handleManifest(c.req.param("token"), {
      store: captureStore,
      phoneInfo: {
        userAgent: ua,
        ip: remoteIp,
      },
    });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/upload", async (c) => {
    const token = c.req.query("token") ?? "";
    const multipart = await readMultipartRequest(c.req.raw, 11 * 1024 * 1024);
    if (!multipart.ok) return jsonResponse({ ok: false, error: multipart.error }, 400);
    const file = multipart.parsed.files.file;
    if (!file) return jsonResponse({ ok: false, error: "missing 'file' part" }, 400);
    const result = await handleUpload(
      { token, bytes: file.data, originalName: file.filename ?? "upload" },
      { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/delete-photo", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handleDeletePhoto(
      { token: String(parsed.body.token ?? ""), index: Number(parsed.body.index) },
      { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/finalize", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handleFinalize(
      { token: String(parsed.body.token ?? "") },
      { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR, uploadsDir: CAPTURE_UPLOADS_DIR },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/discard", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = handleDiscard(
      {
        sessionId: String(parsed.body.sessionId ?? ""),
        reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
      },
      { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
    );
    return jsonResponse(result.body, result.status);
  });

  app.get("/api/capture/sessions", () => {
    return jsonResponse(captureStore.listAll().map(serializeCaptureSession));
  });

  app.get("/api/capture/photos/:sessionId/:index", async (c) => {
    const sessionId = c.req.param("sessionId");
    const index = Number(c.req.param("index"));
    if (!/^[a-f0-9-]{8,80}$/i.test(sessionId) || !Number.isInteger(index) || index < 0) {
      return new Response(null, { status: 404 });
    }
    const session = captureStore.getById(sessionId);
    const photo = session?.photos.find((item) => item.index === index);
    if (!session || !photo) return new Response(null, { status: 404 });
    const filePath = join(CAPTURE_PHOTOS_DIR, sessionId, photo.filename);
    let photoStat;
    try {
      photoStat = await statAsync(filePath);
    } catch {
      return new Response(null, { status: 404 });
    }
    return new Response(createReadStream(filePath) as unknown as BodyInit, {
      headers: {
        "Content-Type": photo.mime,
        "Cache-Control": "no-cache, must-revalidate",
        "Content-Length": String(photoStat.size),
      },
    });
  });

  app.post("/api/capture/replace-photo", async (c) => {
    const multipart = await readMultipartRequest(c.req.raw, 11 * 1024 * 1024);
    if (!multipart.ok) return jsonResponse({ ok: false, error: multipart.error }, 400);
    const file = multipart.parsed.files.file;
    if (!file) return jsonResponse({ ok: false, error: "missing 'file' part" }, 400);
    const token = multipart.parsed.fields.token ?? "";
    const indexRaw = multipart.parsed.fields.index;
    if (!token) return jsonResponse({ ok: false, error: "missing 'token' field" }, 400);
    if (indexRaw === undefined) return jsonResponse({ ok: false, error: "missing 'index' field" }, 400);
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0) {
      return jsonResponse({ ok: false, error: "'index' must be a non-negative integer" }, 400);
    }
    const blurField = multipart.parsed.fields.blurScore;
    const blurScore = blurField !== undefined && blurField !== "" ? Number(blurField) : undefined;
    const result = await handleReplacePhoto(
      {
        token,
        index,
        bytes: file.data,
        originalName: file.filename ?? "upload",
        ...(typeof blurScore === "number" && Number.isFinite(blurScore) ? { blurScore } : {}),
      },
      { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/reorder", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = handleReorder(
      {
        token: String(parsed.body.token ?? ""),
        fromIndex: Number(parsed.body.fromIndex),
        toIndex: Number(parsed.body.toIndex),
      },
      { store: captureStore },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/extend", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const byMsRaw = parsed.body.byMs;
    const byMs = typeof byMsRaw === "number" && Number.isFinite(byMsRaw) ? byMsRaw : undefined;
    const result = handleExtend(
      { sessionId: String(parsed.body.sessionId ?? ""), ...(byMs !== undefined ? { byMs } : {}) },
      { store: captureStore },
    );
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/capture/validate", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = handleValidate(
      { sessionId: String(parsed.body.sessionId ?? "") },
      { store: captureStore },
    );
    return jsonResponse(result.body, result.status);
  });

  app.get("/api/capture/registry", () => jsonResponse(captureRegistrations));

  app.get("/capture-assets/heic2any.min.js", () => {
    const asset = getHeic2anyAsset();
    if (!asset) {
      return new Response("heic2any not installed on dashboard host - run `npm install heic2any`", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(asset as unknown as BodyInit, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(asset.length),
      },
    });
  });
}
