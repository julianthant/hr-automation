import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./App";
import { installOperatorFetchAuth } from "./lib/operator-auth";
import "./index.css";

installOperatorFetchAuth();
createRoot(document.getElementById("root")!).render(<DashboardApp />);
