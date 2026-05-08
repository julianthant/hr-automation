import { useState, useEffect } from "react";
import type { SessionState } from "@/components/shared/types";
import { sseHub } from "@/lib/sse-hub";
import { sessionStateEqual } from "./session-state-equal";

const EMPTY_STATE: SessionState = { workflows: [], duoQueue: [] };

/**
 * Cheap structural fingerprint compare to avoid re-rendering when the SSE
 * payload is structurally identical. The actual comparison logic lives in
 * `session-state-equal.ts` so it can be unit-tested without React.
 *
 * This replaces the previous `JSON.stringify` short-circuit (1-5ms per tick
 * on large payloads) and the briefly-broken "no dedupe" variant (Tier 3
 * Task 10B) which caused TerminalDrawer's filter() to produce fresh array
 * refs on every tick, defeating React.memo on children.
 */
export function useSessions(): { state: SessionState; connected: boolean } {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const unsubscribe = sseHub.subscribe<SessionState>(
      "sessions",
      {},
      (data) => {
        setConnected(true);
        setState((prev) => (sessionStateEqual(prev, data) ? prev : data));
      },
      () => {
        setConnected(false);
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, []);

  return { state, connected };
}
