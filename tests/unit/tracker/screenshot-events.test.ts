import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { emitScreenshotEvent } from '../../../src/tracker/jsonl.js'
import { readSessionEvents } from '../../../src/tracker/session-events.js'

test('emitScreenshotEvent appends a screenshot record to a dated sessions file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scr-evt-'))
  emitScreenshotEvent({
    type: 'screenshot', runId: 'run-1', ts: 1776712000000,
    timestamp: new Date(1776712000000).toISOString(),
    kind: 'form', label: 'kuali-saved', step: 'kuali-finalization',
    files: [{ system: 'kuali', path: '/tmp/a.png' }],
  }, { dir: tmp })
  // Events now go to a dated sessions-YYYY-MM-DD.jsonl file; use readSessionEvents to find them.
  const events = readSessionEvents(tmp)
  const screenshotEvents = events.filter((e) => e.type === 'screenshot')
  assert.equal(screenshotEvents.length, 1)
  const parsed = screenshotEvents[0] as any
  assert.equal(parsed.type, 'screenshot')
  assert.equal(parsed.label, 'kuali-saved')
  assert.equal(parsed.files.length, 1)
})
