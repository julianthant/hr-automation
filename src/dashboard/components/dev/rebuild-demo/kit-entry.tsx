import { createRoot } from "react-dom/client";
import "@/index.css";
import { DemoUiKit } from "./DemoUiKit";

/**
 * DEV-ONLY — standalone mount for the design-system specimen page.
 *
 * Pulls in the dashboard's own `index.css` (so the demo tokens resolve against
 * the real theme, exactly as they will inside the app) and renders the kit.
 * See `kit.html` for how to open it.
 */

const root = document.getElementById("ds-kit-root");
if (root) createRoot(root).render(<DemoUiKit />);
