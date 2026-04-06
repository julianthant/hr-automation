# Utils Module

Environment validation, error helpers, and colored logging.

## Files

- `env.ts` — `validateEnv()` checks for `UCPATH_USER_ID` and `UCPATH_PASSWORD` in `process.env`, returns `{ userId, password }`, throws `EnvValidationError` if missing
- `errors.ts` — `errorMessage(err: unknown): string` safely extracts message from caught errors (`err.message` or `String(err)`)
- `log.ts` — `log` namespace with colored console output:
  - `log.step(msg)` — blue `->` prefix
  - `log.success(msg)` — green `✓` prefix
  - `log.waiting(msg)` — yellow `⏳` prefix
  - `log.error(msg)` — red `✗` prefix (writes to stderr)

Uses `picocolors` for colorization. Only `log.error()` uses `console.error` (stderr); all others use `console.log` (stdout).
