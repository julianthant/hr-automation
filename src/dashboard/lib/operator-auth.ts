const OPERATOR_TOKEN_HEADER = "x-hr-auto-operator-token";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OperatorSession {
  token: string;
  header: string;
}

let sessionPromise: Promise<OperatorSession> | undefined;
let originalFetch: typeof fetch | undefined;

/**
 * Fetch (and cache) the per-process operator token. Shared by the `fetch`
 * wrapper and any mutation path that can't use `fetch` (XHR upload progress).
 */
export function getOperatorSession(): Promise<OperatorSession> {
  const doFetch =
    originalFetch ??
    (typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : window.fetch.bind(window));
  sessionPromise ??= doFetch("/api/operator/session", {
    cache: "no-store",
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Operator session unavailable (${response.status})`);
    const value = await response.json() as Partial<{ token: string; header?: string }>;
    if (!value.token || typeof value.token !== "string") {
      throw new Error("Operator session response did not include a token");
    }
    return { token: value.token, header: value.header ?? OPERATOR_TOKEN_HEADER };
  });
  return sessionPromise;
}

/** Install once before React mounts so every existing mutation call is covered. */
export function installOperatorFetchAuth(): void {
  originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!MUTATION_METHODS.has(method)) return originalFetch!(input, init);

    const session = await getOperatorSession();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set(session.header, session.token);
    return originalFetch!(input, { ...init, headers });
  };

  void getOperatorSession().catch(() => {
    // Mutations will surface the same bootstrap failure to their existing UI
    // error handling. Reads remain available for diagnosis.
  });
}
