/**
 * Minimal multipart/form-data parser for one-shot file uploads.
 *
 * Reads the entire request body into memory (capped by `maxBytes`), then
 * splits on the boundary derived from the `Content-Type` header. Returns a
 * map of named parts; binary parts retain `filename` + `contentType` and
 * the raw bytes.
 *
 * Not streaming. Not RFC-complete (no nested multipart, no encoded
 * filenames). Sufficient for "PDF + a couple of small text fields" use
 * cases like the emergency-contact /api/prepare endpoint.
 *
 * Why not a dependency: busboy/formidable would add ~200KB of
 * transitive deps for ~80 lines of work. The dashboard server already
 * hand-rolls a JSON body parser inline; this matches that style.
 */
import type { IncomingMessage } from "http";

export interface MultipartFilePart {
  kind: "file";
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartTextPart {
  kind: "text";
  name: string;
  value: string;
}

export type MultipartPart = MultipartFilePart | MultipartTextPart;

export interface ParsedMultipart {
  parts: MultipartPart[];
  files: Record<string, MultipartFilePart>;
  fields: Record<string, string>;
}

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

/**
 * Pull the boundary token out of a Content-Type header. Returns `undefined`
 * if the header is missing, isn't multipart, or has no boundary parameter.
 */
export function parseBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  if (!/^multipart\/form-data\b/i.test(contentType.trim())) return undefined;
  const m = contentType.match(/boundary=("([^"]+)"|([^;\s]+))/i);
  if (!m) return undefined;
  return m[2] ?? m[3];
}

/**
 * Find every occurrence of `needle` in `hay`. Returns a sorted list of
 * starting offsets. Used to slice the body on the boundary marker.
 */
function findAll(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/** Parse one part's headers into a map (lowercased keys). */
function parsePartHeaders(headerBuf: Buffer): Record<string, string> {
  const lines = headerBuf.toString("utf8").split("\r\n");
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
}

/**
 * Pull a parameter value out of a Content-Disposition header.
 * Example: `form-data; name="pdf"; filename="scan.pdf"` → `name` → `pdf`.
 * Tolerates both quoted and unquoted forms.
 */
function getDispositionParam(disposition: string, key: string): string | undefined {
  const re = new RegExp(`${key}="([^"]*)"|${key}=([^;\\s]+)`, "i");
  const m = disposition.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/**
 * Parse a Buffer of `Content-Type: multipart/form-data; boundary=…` body
 * into named parts. Empty body or non-matching boundary returns an empty
 * result (no throw).
 */
export function parseMultipartBuffer(body: Buffer, boundary: string): ParsedMultipart {
  const result: ParsedMultipart = { parts: [], files: {}, fields: {} };
  const dashBoundary = Buffer.from(`--${boundary}`);
  const offsets = findAll(body, dashBoundary);
  if (offsets.length < 2) return result;

  for (let i = 0; i < offsets.length - 1; i++) {
    // The bytes after the boundary marker can be either CRLF (a real part
    // follows) or "--" (terminator). Skip terminator slices.
    const after = body.slice(
      offsets[i] + dashBoundary.length,
      offsets[i] + dashBoundary.length + 2,
    );
    if (after[0] === 0x2d && after[1] === 0x2d) break;

    const partStart = offsets[i] + dashBoundary.length + CRLF.length;
    const partEnd = offsets[i + 1] - CRLF.length;
    if (partEnd <= partStart) continue;

    const part = body.slice(partStart, partEnd);
    const headerEnd = part.indexOf(DOUBLE_CRLF);
    if (headerEnd < 0) continue;

    const headers = parsePartHeaders(part.slice(0, headerEnd));
    const data = part.slice(headerEnd + DOUBLE_CRLF.length);
    const disposition = headers["content-disposition"];
    if (!disposition) continue;
    const name = getDispositionParam(disposition, "name");
    if (!name) continue;
    const filename = getDispositionParam(disposition, "filename");
    if (filename !== undefined) {
      const filePart: MultipartFilePart = {
        kind: "file",
        name,
        filename,
        contentType: headers["content-type"] ?? "application/octet-stream",
        data,
      };
      result.parts.push(filePart);
      result.files[name] = filePart;
    } else {
      const textPart: MultipartTextPart = {
        kind: "text",
        name,
        value: data.toString("utf8"),
      };
      result.parts.push(textPart);
      result.fields[name] = textPart.value;
    }
  }
  return result;
}

/**
 * Read the entire request body into a Buffer with a hard size cap. Throws
 * if the request exceeds `maxBytes` (the cap protects against a runaway
 * upload swamping the SSE server).
 */
export async function readRequestBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      throw new Error(`Request body too large (>${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Convenience wrapper: read the body and parse as multipart. Returns
 * `{ ok: false, error }` for unparseable / mistyped requests so the route
 * handler can write a clean 400 instead of throwing.
 */
export async function readMultipart(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; parsed: ParsedMultipart } | { ok: false; error: string }> {
  try {
    const boundary = parseBoundary(req.headers["content-type"]);
    if (!boundary) {
      return { ok: false, error: "Content-Type must be multipart/form-data with a boundary" };
    }
    const body = await readRequestBuffer(req, maxBytes);
    const parsed = parseMultipartBuffer(body, boundary);
    return { ok: true, parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
