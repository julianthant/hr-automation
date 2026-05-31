// Loaded before other test imports (and before any Date is constructed in a
// test module) so timezone-sensitive assertions are deterministic regardless
// of the runner's TZ. The tracker derives local-calendar filenames/dates and
// the suite was authored in Pacific time; CI runs in UTC, which silently broke
// local-vs-UTC date tests (e.g. trackerDateForTimestamp). Pin Pacific
// unconditionally so dev and CI agree — the suite's local-calendar assumptions
// only hold in this zone.
process.env.TZ = "America/Los_Angeles";

// Loaded before other test imports so src/config.ts TIMEKEEPER_NAME validation succeeds.
process.env.TIMEKEEPER_NAME ??= "test-timekeeper";

export {};
