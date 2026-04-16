import { SCREEN } from "../config.js";

export interface TileLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  args: string[];
}

const CASCADE_OFFSET = 40;

export function computeTileLayout(
  index: number,
  total: number,
  screen?: { width: number; height: number },
): TileLayout {
  const W = screen?.width ?? SCREEN.width;
  const H = screen?.height ?? SCREEN.height;

  const margin = CASCADE_OFFSET * (total - 1);
  const winW = W - margin;
  const winH = H - margin;
  const x = CASCADE_OFFSET * index;
  const y = CASCADE_OFFSET * index;

  return {
    position: { x, y },
    size: { width: winW, height: winH },
    viewport: { width: winW - 20, height: winH - 80 },
    args: [`--window-position=${x},${y}`, `--window-size=${winW},${winH}`],
  };
}
