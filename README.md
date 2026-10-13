# HR Automation

A local HR operations app that coordinates browser workflows across UCPath, Kuali, Kronos, CRM, and document systems.

Built for a UCSD HR operator, the app combines work that otherwise crosses several portals into a dashboard with queues, step logs, document review, and browser-session controls. Workflows cover onboarding, separations, person lookup, work-study updates, Kronos pay rules, oath signatures and uploads, emergency contacts, OnBase imports, I-9 checks, and CRM document downloads. OCR prepares scanned forms for review and downstream workflows. SharePoint downloads support roster lookup. Old Kronos report automation also exists, but is outside the generic dashboard workflow loader.

## How it works

A React dashboard sends requests to a local Node.js backend built with Hono. Server-sent events stream progress back to the operator. A shared TypeScript workflow kernel manages steps, browser sessions, cancellation, and delegated work. Workflow modules compose system-specific Playwright drivers rather than carrying their own selectors and login code.

SQLite stores tasks, attempts, worker claims, and dependencies. JSONL records preserve workflow events, logs, and session history for the dashboard. OCR-backed operations can wait for review before creating downstream work, while daemon workers process queued items through reusable authenticated browser sessions.

## Engineering problems addressed

- Cross-system authentication and navigation. Shared SSO helpers and Duo approval handling coordinate multiple browser sessions. UCPath drivers account for PeopleSoft content frames and overlays that can block form controls.
- Identity ambiguity. A separation that resolves to a different employee pauses for operator review instead of silently substituting the match and continuing to termination.
- Committing a transaction safely. Separation dry runs stop before UCPath submission and Kuali finalization. They may still fill fields in an unsubmitted Kuali draft. Verified transaction receipts support reuse of existing work, and a submission without an extracted transaction number stops before Kuali finalization.
- Worker races and uncertain persistence. Queue claims carry expiring leases and generations. Terminal-state writes retry and reconcile against stored state. If persistence remains uncertain, the worker blocks the claim rather than returning it to the executable queue.

## Stack and scope

TypeScript, Node.js, Playwright, React, Hono, SQLite, Zod, Vite, Tailwind CSS, ExcelJS, and Vitest. The repository includes unit and architecture tests, plus a separate live-test lane. Live operation requires institutional access and local configuration.

The public history contains 2,507 commits reachable from `HEAD`, with commit dates spanning March 13 through October 12, 2026. Publication preparation may change that history.

Real HR data, credentials, and operational evidence belong in operator-only local storage outside the tracked repository. The code expects separately supplied documents, rosters, authentication state, and configuration. This README describes the software and does not include personnel records.
