# Services Layer

Reusable stateful or IO-backed capabilities used by workflows and the dashboard backend.

## Modules

- `capture/` — mobile photo upload sessions, QR/mobile client support, and PDF bundling.
- `matching/` — roster loading, name/address/EID matching, and optional LLM disambiguation.
- `ocr/` — PDF/page rendering, OCR provider calls, key rotation/cache, and OCR form specs.

Services can do IO and coordinate providers. Pure HR rules should move to `src/domain/` when they no longer need service dependencies.
