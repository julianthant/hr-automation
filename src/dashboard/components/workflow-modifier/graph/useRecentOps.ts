// Recently-placed data-bank ops, persisted to localStorage so the palette can
// surface a short "Recently used" shortcut row across editor sessions. Identity
// is the op id; most-recent first, capped. Storage failures degrade to empty.

import { useCallback, useState } from "react";

const KEY = "workflow-modifier.recent-ops";
const MAX = 6;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function useRecentOpIds(): { recentIds: string[]; pushRecent: (id: string) => void } {
  const [recentIds, setRecentIds] = useState<string[]>(readRecent);
  const pushRecent = useCallback((id: string) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX);
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode / quota — recents are a nicety, not load-bearing */
      }
      return next;
    });
  }, []);
  return { recentIds, pushRecent };
}
