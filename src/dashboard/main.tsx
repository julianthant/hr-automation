import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkflowsProvider } from "./workflows-context";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <WorkflowsProvider>
    <App />
  </WorkflowsProvider>
);
