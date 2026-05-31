import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../../src/core/kernel/workflow.js'
import { clear } from '../../../../src/core/kernel/registry.js'
import { buildShutdownTrackerData } from '../../../../src/core/daemon/shutdown.js'
import { buildHttpPendingData } from '../../../../src/core/daemon/enqueue-dispatch.js'
import { emitTrackerRow } from '../../../../src/tracker/jsonl.js'

// buildShutdownTrackerData rebuilds the cancelled/shutdown row's `data` from
// `input`. That re-derives name/EID/archetype/queueRowKind, but it CANNOT
// reproduce `data.__traceId` — the trace id is frozen once at pre-emit and
// embeds the original timestamp. These tests pin that the rebuilt row carries
// the frozen trace id forward (inherited from the run's pending row) so a
// cancelled row keeps the exact subtitle/hover identity it showed while
// pending: cancellation changes status only, never the trace-id.

function makeWf() {
  clear()
  return defineWorkflow({
    name: 'shutdown-trace',
    code: 'st',
    queueRowKind: 'person',
    schema: z.object({ id: z.string() }),
    steps: ['a'],
    systems: [],
    authSteps: false,
    handler: async () => {},
  })
}

test('buildShutdownTrackerData carries the frozen __traceId forward from the pending row', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-trace-'))
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const wf = makeWf()
  const runId = 'aaaabbbb-1111-2222-3333-444455556666'
  const input = { id: 'E12345' }

  // Emit the pending row exactly as the enqueue path does (runId passed → it
  // stamps data.__traceId).
  const pendingData = buildHttpPendingData(wf, input, undefined, runId)
  assert.ok(pendingData.__traceId, 'precondition: pending row carries a trace id')
  emitTrackerRow(
    {
      workflow: wf.config.name,
      timestamp: new Date().toISOString(),
      id: 'item-1',
      runId,
      status: 'pending',
      data: pendingData,
    },
    dir,
  )

  const cancelledData = buildShutdownTrackerData(wf, input, undefined, { runId, trackerDir: dir })
  assert.equal(
    cancelledData.__traceId,
    pendingData.__traceId,
    'cancelled row must inherit the exact frozen trace id, not drop or regenerate it',
  )
})

test('buildShutdownTrackerData omits __traceId (no throw) when no prior row exists', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-trace-missing-'))
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const wf = makeWf()

  const data = buildShutdownTrackerData(wf, { id: 'E999' }, undefined, {
    runId: 'no-prior-row-runid',
    trackerDir: dir,
  })
  assert.equal(data.__traceId, undefined)
  assert.ok(data.archetype, 'still produces a fully stamped row')
})

test('buildShutdownTrackerData without opts leaves __traceId unstamped (rebuild cannot mint it)', () => {
  const wf = makeWf()
  const data = buildShutdownTrackerData(wf, { id: 'E1' }, undefined)
  assert.equal(data.__traceId, undefined)
})
