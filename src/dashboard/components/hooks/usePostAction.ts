import { useCallback, useState } from "react";
import { toast } from "@/lib/notify";

interface PostActionResult<TBody> {
  ok: boolean;
  body?: TBody;
  error?: string;
  status: number;
}

interface ToastConfig<TBody> {
  loading: string | ((requestBody: unknown) => string);
  success?: (body: TBody) => string | { message: string; description?: string };
  partial?: (body: TBody) => string | { message: string; description?: string };
  error: (msg: string, status?: number) => string | { message: string; description?: string };
  isPartial?: (body: TBody) => boolean;
}

function parseToastMessage(value: string | { message: string; description?: string }) {
  return typeof value === "string" ? { message: value, description: undefined } : value;
}

function readError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const obj = body as { error?: unknown; errors?: Array<{ error?: unknown }> };
    const firstError = obj.errors?.[0]?.error;
    if (typeof firstError === "string" && firstError.trim()) return firstError;
    if (typeof obj.error === "string" && obj.error.trim()) return obj.error;
  }
  return `HTTP ${status}`;
}

export function usePostAction<TBody = Record<string, unknown>>(
  endpoint: string,
  toasts: ToastConfig<TBody>,
) {
  const [pending, setPending] = useState(false);

  const run = useCallback(async (requestBody: unknown): Promise<PostActionResult<TBody>> => {
    setPending(true);
    const loadingText =
      typeof toasts.loading === "function" ? toasts.loading(requestBody) : toasts.loading;
    const toastId = toast.loading(loadingText);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      // Fail loud: every bulk-action route responds with an explicit `ok`
      // flag, so a malformed/unparseable 2xx body must NOT read as success —
      // a parse failure or a stray `{}` would otherwise act on / purge every
      // targeted row as "success, 0 errors" with the real per-item outcome
      // unknown.
      let body: TBody | undefined;
      try {
        body = (await res.json()) as TBody;
      } catch {
        body = undefined;
      }
      const bodyOk = Boolean(body && typeof body === "object" && (body as { ok?: unknown }).ok === true);
      if (!res.ok || !bodyOk) {
        const msg = body === undefined ? "Malformed server response" : readError(body, res.status);
        const errToast = parseToastMessage(toasts.error(msg, res.status));
        toast.error(errToast.message, { id: toastId, description: errToast.description });
        return { ok: false, body, error: msg, status: res.status };
      }
      // bodyOk (checked above) guarantees `body` is a well-formed TBody here.
      const okBody = body as TBody;
      const formatter =
        toasts.partial && toasts.isPartial?.(okBody) ? toasts.partial : toasts.success;
      if (formatter) {
        const okToast = parseToastMessage(formatter(okBody));
        const fn = toasts.partial && toasts.isPartial?.(okBody) ? toast.warning : toast.success;
        fn(okToast.message, { id: toastId, description: okToast.description });
      } else {
        toast.dismiss(toastId);
      }
      return { ok: true, body: okBody, status: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errToast = parseToastMessage(toasts.error(msg));
      toast.error(errToast.message, { id: toastId, description: errToast.description });
      return { ok: false, error: msg, status: 0 };
    } finally {
      setPending(false);
    }
  }, [endpoint, toasts]);

  return { pending, run };
}
