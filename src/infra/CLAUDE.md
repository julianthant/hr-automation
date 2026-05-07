# Infra Layer

Runtime infrastructure that makes browser automation possible. This layer may depend on Playwright, environment variables, SSO/Duo state, and OS/browser process behavior.

## Modules

- `auth/` — UCSD SSO, Duo polling, per-system login flows, SSO field helpers, voice/Telegram auth cues.
- `browser/` — Playwright Chromium launch/session primitives and browser window setup.

Infra should not contain HR business rules. Put business meaning in `src/domain/`, reusable app capabilities in `src/services/`, and external system page drivers in `src/systems/`.
