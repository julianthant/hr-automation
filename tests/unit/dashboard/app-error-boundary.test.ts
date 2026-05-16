import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AppErrorBoundary } from "../../../src/dashboard/components/shared/AppErrorBoundary.js";

describe("AppErrorBoundary", () => {
  it("renders a dashboard crash fallback for captured render errors", () => {
    const error = new Error("boom");
    const boundary = new AppErrorBoundary({ children: "ok" });
    boundary.state = AppErrorBoundary.getDerivedStateFromError(error);

    const html = renderToStaticMarkup(boundary.render());

    assert.match(html, /Dashboard crashed/);
    assert.match(html, /boom/);
    assert.match(html, /Try again/);
  });
});
