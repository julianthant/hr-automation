import { SCREEN } from "../config.js";

export interface TileLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  args: string[];
}

export function computeTileLayout(
  index: number,
  total: number,
  screen?: { width: number; height: number },
): TileLayout {
  const W = screen?.width ?? SCREEN.width;
  const H = screen?.height ?? SCREEN.height;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const winW = Math.floor(W / cols);
  const winH = Math.floor(H / rows);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = col * winW;
  const y = row * winH;

  return {
    position: { x, y },
    size: { width: winW, height: winH },
    viewport: { width: winW - 20, height: winH - 80 },
    args: [`--window-position=${x},${y}`, `--window-size=${winW},${winH}`],
  };
}
