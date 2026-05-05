import { createReadStream } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import type { ServerResponse } from "node:http";

export async function streamPngFile(
  res: ServerResponse,
  path: string,
  opts: { cacheControl: string },
): Promise<void> {
  const size = (await statAsync(path)).size;
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": size,
    "Cache-Control": opts.cacheControl,
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(path).pipe(res);
}
