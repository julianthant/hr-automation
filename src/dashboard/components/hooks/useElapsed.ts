import { useState, useEffect } from "react";

/** Returns a live "Xm Ys" string that counts up from startTime. */
export function useElapsed(startTime: string | null): string {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!startTime) {
      setElapsed("");
      return;
    }
    const start = new Date(startTime).getTime();
    const update = () => {
      const diff = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(`${m}m ${s.toString().padStart(2, "0")}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  return elapsed;
}

/** Format a duration in seconds to "Xm Ys" (static, no hook). */
export function formatDuration(startIso: string, endIso: string): string {
  const diff = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
