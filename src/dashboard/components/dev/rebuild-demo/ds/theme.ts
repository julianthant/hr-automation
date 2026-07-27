import { useCallback, useEffect, useState } from "react";

/**
 * DEV-ONLY — the demo's theme pair.
 *
 * `Graphite Warm` (dark) and `Paper Ink` (light) are two compositions of the
 * SAME product, not a colour scheme and its inverse: each is authored as its
 * own contiguous block in `ds/tokens.css`, with its own hues, its own text
 * steps, and its own mechanic for separating one plane from the next (a
 * hairline on the dark theme, a shadow on the light one).
 *
 * WHY THIS FILE STAMPS THREE ELEMENTS. The shipped dashboard hardcodes
 * `class="dark"` on BOTH `<html>` and `<body>` (`index.html`), and a `.dark`
 * ANCESTOR re-scopes every semantic token — which is exactly how an earlier
 * session lost hours to a light theme that rendered dark. So the attribute
 * goes on:
 *
 *   1. `<html>`  — matched by `:root[data-demo-theme=…]` (0,2,0) > `.dark` (0,1,0)
 *   2. `<body>`  — matched by `body[data-demo-theme=…]` (0,1,1) > `.dark` (0,1,0);
 *                  a declaration on `<body>` itself beats anything inherited,
 *                  so stamping `<html>` alone is not enough
 *   3. the demo's own root container — matched by the bare attribute selector,
 *      which is what keeps the demo self-describing in the DOM
 *
 * (3) alone would leave every PORTALLED surface — dialog, drawer, tooltip,
 * popover, toast, all of which mount under `<body>` — on the app's theme. (1)
 * and (2) are what make the overlays follow.
 *
 * Both values are stamped, dark included: the demo's themes are demo-scoped
 * overrides of the app's tokens, so "dark" is a real selection here and not a
 * fall-through to `.dark`.
 */

export type DemoTheme = "dark" | "light";

export const DEMO_THEME_ATTR = "data-demo-theme";

const STORAGE_KEY = "rebuild-demo.theme";

export const DEMO_THEME_LABEL: Record<DemoTheme, string> = {
  dark: "Graphite Warm",
  light: "Paper Ink",
};

function readStoredTheme(): DemoTheme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    // A blocked localStorage is a real, expected browser state (private mode,
    // storage disabled). It is not a failure to read a theme — it means there
    // is no stored preference, which is the documented default.
    return "dark";
  }
}

/**
 * Owns the demo's theme: the selected value, the DOM stamp, and persistence.
 *
 * Mount it once, at the demo's root. The returned `theme` goes on the root
 * container so the attribute is visible where the demo lives; the hook has
 * already put it on `<html>` and `<body>` for the portals.
 */
export function useDemoTheme(): {
  theme: DemoTheme;
  setTheme: (next: DemoTheme) => void;
  toggleTheme: () => void;
} {
  const [theme, setThemeState] = useState<DemoTheme>(readStoredTheme);

  useEffect(() => {
    const html = document.documentElement;
    const { body } = document;
    html.setAttribute(DEMO_THEME_ATTR, theme);
    body.setAttribute(DEMO_THEME_ATTR, theme);
    return () => {
      // The demo is one view inside the real dashboard; leaving the attribute
      // behind would re-theme every other view.
      html.removeAttribute(DEMO_THEME_ATTR);
      body.removeAttribute(DEMO_THEME_ATTR);
    };
  }, [theme]);

  const setTheme = useCallback((next: DemoTheme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort and not load-bearing: the selection still
      // applies for this session. Nothing downstream reads it back as truth.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: DemoTheme = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* see setTheme */
      }
      return next;
    });
  }, []);

  return { theme, setTheme, toggleTheme };
}
