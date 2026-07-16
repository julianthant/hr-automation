import { test, describe, it, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildScreenshotsHandler } from '../../../src/tracker/dashboard.js'
import { openStateDb, closeStateDbForTests, stateDbPath } from '../../../src/tracker/state/db.js'
import { trackEvent, emitScreenshotEvent, dateLocal } from '../../../src/tracker/jsonl.js'
import { sessionFilePath, sessionsDir } from '../../../src/tracker/paths.js'
import { buildDeleteEntryHandler } from '../../../src/control/ops/delete.js'

test('returns grouped entries only for screenshot session events (ignores orphan disk PNGs)', async () => {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scr-dash-'))
  const shotsDir = path.join(trackerDir, 'screenshots')
  await fs.mkdir(shotsDir, { recursive: true })

  const ts = 1776712000000
  await fs.writeFile(path.join(shotsDir, `separations-3907-form-kuali-saved-kuali-${ts}.png`), 'x')
  await fs.writeFile(path.join(shotsDir, `separations-3907-form-kuali-saved-ucpath-${ts}.png`), 'x')
  // No session event for this file — must not appear in grouped API output.
  await fs.writeFile(path.join(shotsDir, 'separations-3907-kuali-extraction-old-kronos-1776709123932.png'), 'x')

  const sessionDay = dateLocal(new Date(ts))
  await fs.mkdir(sessionsDir(trackerDir), { recursive: true })
  await fs.writeFile(sessionFilePath(sessionDay, trackerDir), JSON.stringify({
    type: 'screenshot', runId: 'r1', ts, kind: 'form', label: 'kuali-saved', step: 'kuali-finalization',
    timestamp: new Date(ts).toISOString(),
    files: [
      { system: 'kuali', path: path.join(shotsDir, `separations-3907-form-kuali-saved-kuali-${ts}.png`) },
      { system: 'ucpath', path: path.join(shotsDir, `separations-3907-form-kuali-saved-ucpath-${ts}.png`) },
    ],
  }) + '\n')

  const handler = buildScreenshotsHandler({ dir: trackerDir, screenshotsDir: shotsDir })
  const res = await handler({ workflow: 'separations', itemId: '3907' })
  const byKey = Object.fromEntries(res.map(e => [e.label, e]))
  assert.equal(byKey['kuali-saved'].kind, 'form')
  assert.equal(byKey['kuali-saved'].files.length, 2)
  assert.equal(res.some((e) => e.label === 'legacy'), false)

  closeStateDbForTests(trackerDir)
  rmSync(trackerDir, { recursive: true, force: true })
})

describe('grouped handler SQLite vs JSONL parity', () => {
  let trackerDir: string
  let shotsDir: string

  beforeEach(async () => {
    trackerDir = mkdtempSync(join(tmpdir(), 'scr-parity-'))
    shotsDir = join(trackerDir, 'screenshots')
    await fs.mkdir(shotsDir, { recursive: true })
  })

  afterEach(() => {
    closeStateDbForTests(trackerDir)
    rmSync(trackerDir, { recursive: true, force: true })
  })

  it('SQLite path returns same shape as JSONL+disk fallback', async () => {
    const ts = 1776712000000

    // 1. Create a physical PNG so registerLocalFile (existsSync) doesn't skip it.
    const pngPath = join(shotsDir, `separations-3907-form-kuali-saved-kuali-${ts}.png`)
    writeFileSync(pngPath, 'fake-png-data')

    // 2. Open the DB so applyTrackerEntry/applySessionEvent feed into it.
    openStateDb(trackerDir)

    // 3. Emit a tracker entry to populate the runs table with workflow+item_id
    //    so applyScreenshotFiles can look them up via run_id.
    trackEvent({
      workflow: 'separations',
      timestamp: new Date(ts).toISOString(),
      id: '3907',
      runId: 'run-parity-1',
      status: 'running',
      data: {},
    }, trackerDir)

    // 4. Emit the screenshot event — populates rotated session snapshots + SQLite files table.
    emitScreenshotEvent({
      type: 'screenshot',
      runId: 'run-parity-1',
      ts,
      timestamp: new Date(ts).toISOString(),
      kind: 'form',
      label: 'kuali-saved',
      step: 'kuali-finalization',
      files: [{ system: 'kuali', path: pngPath }],
    }, { dir: trackerDir })

    // 5. Call the grouped handler — should use SQLite path since isStateDbReady is true.
    const handler = buildScreenshotsHandler({ dir: trackerDir, screenshotsDir: shotsDir })
    const fromSqlite = await handler({ workflow: 'separations', itemId: '3907' })

    // 6. Force fallback: close+remove the DB.
    closeStateDbForTests(trackerDir)
    rmSync(stateDbPath(trackerDir), { force: true })

    // 7. Call again — should fall back to JSONL+disk legacy path.
    const handler2 = buildScreenshotsHandler({ dir: trackerDir, screenshotsDir: shotsDir })
    const fromLegacy = await handler2({ workflow: 'separations', itemId: '3907' })

    // 8. Both paths must return at least one entry with the same label + kind.
    assert.ok(fromSqlite.length > 0, 'SQLite path returned no entries')
    assert.ok(fromLegacy.length > 0, 'Legacy path returned no entries')

    // Find the kuali-saved entry in both results.
    const sqliteEntry = fromSqlite.find(e => e.label === 'kuali-saved')
    const legacyEntry = fromLegacy.find(e => e.label === 'kuali-saved')
    assert.ok(sqliteEntry, 'SQLite path missing kuali-saved entry')
    assert.ok(legacyEntry, 'Legacy path missing kuali-saved entry')

    // Shapes must match (spread for null-prototype-row compat).
    assert.equal({ ...sqliteEntry }.kind, { ...legacyEntry }.kind)
    assert.equal({ ...sqliteEntry }.label, { ...legacyEntry }.label)
    assert.equal({ ...sqliteEntry }.step, { ...legacyEntry }.step)
    assert.equal({ ...sqliteEntry }.files.length, { ...legacyEntry }.files.length)
  })

  it('SQLite path lists only files rows matched to session events (hides orphan disk PNGs)', async () => {
    const tsOld = 1776700000000
    const tsNew = 1776712000000
    const orphanName = `separations-3907-error-pre-sqlite-kuali-${tsOld}.png`
    const registeredName = `separations-3907-form-kuali-saved-kuali-${tsNew}.png`
    writeFileSync(join(shotsDir, orphanName), 'old-png')
    writeFileSync(join(shotsDir, registeredName), 'new-png')

    openStateDb(trackerDir)
    trackEvent({
      workflow: 'separations',
      timestamp: new Date(tsNew).toISOString(),
      id: '3907',
      runId: 'run-after-rerun',
      status: 'running',
      data: {},
    }, trackerDir)

    emitScreenshotEvent({
      type: 'screenshot',
      runId: 'run-after-rerun',
      ts: tsNew,
      timestamp: new Date(tsNew).toISOString(),
      kind: 'form',
      label: 'kuali-saved',
      step: 'kuali-finalization',
      files: [{ system: 'kuali', path: join(shotsDir, registeredName) }],
    }, { dir: trackerDir })

    const handler = buildScreenshotsHandler({ dir: trackerDir, screenshotsDir: shotsDir })
    const res = await handler({ workflow: 'separations', itemId: '3907' })
    const byLabel = Object.fromEntries(res.map((e) => [e.label, e]))
    assert.ok(byLabel['kuali-saved'], 'registered screenshot entry missing')
    assert.equal(byLabel['kuali-saved'].files.length, 1)
    assert.equal(
      res.some((e) => e.files.some((f) => f.path.endsWith(orphanName))),
      false,
      'orphan PNG on disk without matching screenshot event must not appear',
    )
  })

  it('does not fall back to raw session events after the owning run is deleted', async () => {
    const ts = Date.now()
    const pngPath = join(shotsDir, `separations-3907-form-kuali-saved-kuali-${ts}.png`)
    writeFileSync(pngPath, 'retained-audit-png')
    openStateDb(trackerDir)
    trackEvent({
      workflow: 'separations', timestamp: new Date(ts).toISOString(), id: '3907',
      runId: 'run-deleted-shot', status: 'running', data: {},
    }, trackerDir)
    emitScreenshotEvent({
      type: 'screenshot', runId: 'run-deleted-shot', ts,
      timestamp: new Date(ts).toISOString(), kind: 'form', label: 'kuali-saved',
      step: 'kuali-finalization', files: [{ system: 'kuali', path: pngPath }],
    }, { dir: trackerDir })
    const date = dateLocal(new Date(ts))
    buildDeleteEntryHandler(trackerDir)({
      workflow: 'separations', id: '3907', runId: 'run-deleted-shot', date,
    })

    const handler = buildScreenshotsHandler({ dir: trackerDir, screenshotsDir: shotsDir })
    assert.deepEqual(await handler({
      workflow: 'separations', itemId: '3907', runId: 'run-deleted-shot', trackerDate: date,
    }), [])
    assert.deepEqual(await handler({ workflow: 'separations', itemId: '3907' }), [])
    assert.equal(await fs.stat(pngPath).then(() => true), true, 'audit file stays recoverable')
  })
})
