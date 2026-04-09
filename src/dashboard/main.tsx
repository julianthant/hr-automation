import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@heroui/react";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale="en-US">
    <App />
  </I18nProvider>
);
