import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildScreenshotsHandler } from '../../../src/tracker/dashboard.js'

test('returns grouped entries matching screenshot events, legacy files under kind:error label:legacy', async () => {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scr-dash-'))
  const shotsDir = path.join(trackerDir, 'screenshots')
  await fs.mkdir(shotsDir, { recursive: true })

  const ts = 1776712000000
  // new-convention files
  await fs.writeFile(path.join(shotsDir, `separations-3907-form-kuali-saved-kuali-${ts}.png`), 'x')
  await fs.writeFile(path.join(shotsDir, `separations-3907-form-kuali-saved-ucpath-${ts}.png`), 'x')
  // legacy filename
  await fs.writeFile(path.join(shotsDir, 'separations-3907-kuali-extraction-old-kronos-1776709123932.png'), 'x')

  // matching tracker event for the new files (sessions.jsonl)
  const sessionsJsonl = path.join(trackerDir, 'sessions.jsonl')
  await fs.writeFile(sessionsJsonl, JSON.stringify({
    type: 'screenshot', runId: 'r1', ts, kind: 'form', label: 'kuali-saved', step: 'kuali-finalization',
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
  assert.equal(byKey['legacy'].kind, 'error')
  assert.equal(byKey['legacy'].files.length, 1)
})
