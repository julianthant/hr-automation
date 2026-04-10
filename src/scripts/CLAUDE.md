# Scripts — Dev Tools

Development and debugging scripts. These are NOT production workflows — they're for manual testing, selector exploration, and batch operations.

## Files

- `demo-dashboard.ts` — Simulates workflow events to test dashboard SSE streaming without running real workflows
- `eid-manual-lookup.sh` — Shell script for quick manual EID lookups
- `explore-kronos-selectors.ts` — Opens Kronos browsers and pauses for Playwright Inspector to map selectors
- `kronos-map.ts` — Maps Kronos employee data for batch processing
- `sep-batch.ts` — Batch separations testing tool
- `test-kronos-timecard.ts` — Tests Kronos timecard extraction in isolation

## Usage

Run directly with tsx:
```bash
tsx --env-file=.env src/scripts/<script>.ts
```

## When to Use

- **Selector discovery**: Use `explore-kronos-selectors.ts` to launch headed browsers, then switch to `playwright-cli` for snapshot/mapping
- **Dashboard testing**: Use `demo-dashboard.ts` to verify dashboard changes without triggering real HR system automation
- **Debugging**: Use individual test scripts to isolate a specific system interaction

## Lessons Learned

*(Add entries here when script-related issues are discovered — document what went wrong and the fix)*
