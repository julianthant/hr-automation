import { useState, useEffect, useRef } from "react";
import type { SessionState } from "../types";

const EMPTY_STATE: SessionState = { workflows: [], duoQueue: [] };

export function useSessions(): { state: SessionState; connected: boolean } {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const prevHashRef = useRef<string>("");

  useEffect(() => {
    const es = new EventSource("/events/sessions");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const data: SessionState = JSON.parse(e.data);

        // Skip if unchanged
        const hash = JSON.stringify(data);
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;

        setState(data);
      } catch {
        // Ignore malformed
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { state, connected };
}
