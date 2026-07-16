import { z } from "zod/v4";

const FILE_ATTACHMENT_ID_PATTERN = /^(?:[a-f0-9]{32,64}|[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i;

/** UUID attachment ids plus legacy 32/64-character content-hash ids. */
export function isFileAttachmentId(value: string): boolean {
  return FILE_ATTACHMENT_ID_PATTERN.test(value);
}

export const FileAttachmentIdSchema = z.string().regex(
  FILE_ATTACHMENT_ID_PATTERN,
  "invalid file attachment id",
);
