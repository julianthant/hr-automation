const OPERATOR_TOKEN_HEADER = "x-hr-auto-operator-token";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface OperatorSession {
  token: string;
  header?: string;
}

/** Install once before React mounts so every existing mutation call is covered. */
export function installOperatorFetchAuth(): void {
  const originalFetch = window.fetch.bind(window);
  let sessionPromise: Promise<OperatorSession> | undefined;

  const getSession = (): Promise<OperatorSession> => {
    sessionPromise ??= originalFetch("/api/operator/session", {
      cache: "no-store",
      credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Operator session unavailable (${response.status})`);
      const value = await response.json() as Partial<OperatorSession>;
      if (!value.token || typeof value.token !== "string") {
        throw new Error("Operator session response did not include a token");
      }
      return { token: value.token, header: value.header };
    });
    return sessionPromise;
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!MUTATION_METHODS.has(method)) return originalFetch(input, init);

    const session = await getSession();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set(session.header ?? OPERATOR_TOKEN_HEADER, session.token);
    return originalFetch(input, { ...init, headers });
  };

  void getSession().catch(() => {
    // Mutations will surface the same bootstrap failure to their existing UI
    // error handling. Reads remain available for diagnosis.
  });
}
