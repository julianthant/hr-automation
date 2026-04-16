import { SCREEN } from "../config.js";

export interface TileLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  args: string[];
}

export function computeTileLayout(
  _index: number,
  _total: number,
  screen?: { width: number; height: number },
): TileLayout {
  const W = screen?.width ?? SCREEN.width;
  const H = screen?.height ?? SCREEN.height;

  return {
    position: { x: 0, y: 0 },
    size: { width: W, height: H },
    viewport: { width: W - 20, height: H - 80 },
    args: [`--window-position=0,0`, `--window-size=${W},${H}`],
  };
}
