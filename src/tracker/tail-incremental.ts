import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TailState {
  lastSize: number;
  utf8Pending: string;
}

export function makeTailState(): TailState {
  return { lastSize: 0, utf8Pending: "" };
}

/**
 * Read bytes appended since `state.lastSize`, returning only complete lines.
 * Mutates `state` so callers can cheaply continue from the previous read.
 */
export function tailIncremental(path: string, state: TailState): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }

  if (st.size < state.lastSize) {
    state.lastSize = 0;
    state.utf8Pending = "";
    return [];
  }
  if (st.size === state.lastSize) return [];

  let total = 0;
  const byteLen = st.size - state.lastSize;
  const buf = Buffer.alloc(byteLen);
  try {
    const fd = openSync(path, "r");
    try {
      while (total < byteLen) {
        const n = readSync(fd, buf, total, byteLen - total, state.lastSize + total);
        if (n === 0) break;
        total += n;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  state.lastSize += total;
  if (total === 0) return [];

  const combined = state.utf8Pending + buf.subarray(0, total).toString("utf8");
  const lines = combined.split("\n");
  state.utf8Pending = lines.pop() ?? "";
  return lines.filter((line) => line.length > 0);
}
