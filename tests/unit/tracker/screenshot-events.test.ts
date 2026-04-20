import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { emitScreenshotEvent } from '../../../src/tracker/jsonl.js'

test('emitScreenshotEvent appends a screenshot record to sessions.jsonl', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scr-evt-'))
  emitScreenshotEvent({
    type: 'screenshot', runId: 'run-1', ts: 1776712000000,
    kind: 'form', label: 'kuali-saved', step: 'kuali-finalization',
    files: [{ system: 'kuali', path: '/tmp/a.png' }],
  }, { dir: tmp })
  const raw = await fs.readFile(path.join(tmp, 'sessions.jsonl'), 'utf8')
  const line = raw.trim().split('\n').pop()
  assert.ok(line)
  const parsed = JSON.parse(line!)
  assert.equal(parsed.type, 'screenshot')
  assert.equal(parsed.label, 'kuali-saved')
  assert.equal(parsed.files.length, 1)
})
