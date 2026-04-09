import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Connect to an SSE endpoint, returning parsed data from each message.
 * Reconnects when the URL changes. Returns the latest data payload.
 */
export function useSSE<T>(url: string | null): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!url) {
      setData(null);
      setConnected(false);
      return;
    }

    const es = new EventSource(url);

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        setData(JSON.parse(e.data));
      } catch {
        // ignore malformed messages
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [url]);

  return { data, connected };
}

/**
 * Returns the current time formatted as HH:MM:SS, updated every second.
 */
export function useClock(): string {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );

  useEffect(() => {
    const id = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return time;
}

/**
 * Accumulates SSE log entries (each message appends new entries to the array).
 */
export function useSSELogs(url: string | null) {
  const [logs, setLogs] = useState<unknown[]>([]);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!url) {
      setLogs([]);
      prevLenRef.current = 0;
      return;
    }

    setLogs([]);
    prevLenRef.current = 0;

    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const newEntries = JSON.parse(e.data);
        if (Array.isArray(newEntries)) {
          setLogs((prev) => [...prev, ...newEntries]);
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => {};

    return () => es.close();
  }, [url]);

  return { logs, prevLenRef };
}
