export interface HonoMultipartFile {
  filename?: string;
  mimeType?: string;
  data: Buffer;
}

export type HonoMultipartResult =
  | { ok: true; parsed: { fields: Record<string, string>; files: Record<string, HonoMultipartFile> } }
  | { ok: false; error: string };

export async function readMultipartRequest(
  request: Request,
  maxBytes: number,
): Promise<HonoMultipartResult> {
  try {
    const form = await request.formData();
    const fields: Record<string, string> = {};
    const files: Record<string, HonoMultipartFile> = {};
    let totalBytes = 0;
    for (const [name, value] of form.entries()) {
      if (isFileLike(value)) {
        const data = Buffer.from(await value.arrayBuffer());
        totalBytes += data.byteLength;
        if (totalBytes > maxBytes) return { ok: false, error: "Request body too large" };
        files[name] = {
          data,
          ...(value.name ? { filename: value.name } : {}),
          ...(value.type ? { mimeType: value.type } : {}),
        };
      } else {
        fields[name] = String(value);
        totalBytes += Buffer.byteLength(fields[name]);
        if (totalBytes > maxBytes) return { ok: false, error: "Request body too large" };
      }
    }
    return { ok: true, parsed: { fields, files } };
  } catch {
    return { ok: false, error: "Invalid multipart body" };
  }
}

function isFileLike(value: FormDataEntryValue): value is File {
  return typeof value === "object"
    && value !== null
    && "arrayBuffer" in value
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
    && "name" in value;
}
