import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/index.js'
import { emitTrackerRow } from '../../../src/tracker/jsonl.js'
import type { SystemConfig } from '../../../src/core/kernel/types.js'
import { rowsDir } from '../../../src/tracker/paths.js'

/**
 * The in-process `runWorkflow` real-run path (used by non-daemon `delegateTo`
 * children like OCR/sharepoint-download and by `delegateToAll`) must seed
 * `queueRowKind` + a stable `__traceId` onto EVERY row, not just the pre-emit
 * `pending` one. The dashboard collapses a run to its latest row, so a kind
 * that only lives on `pending` is dropped the instant the run starts.
 */

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-runwf-kind-'))

const fakeLaunch = async ({ system: _system }: { system: SystemConfig }) => ({
  page: {
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'about:blank',
    evaluate: async () => 1,
    screenshot: async () => {},
  } as unknown as import('playwright').Page,
  context: { close: async () => {} } as unknown as import('playwright').BrowserContext,
  browser: null as never,
})

const wf = defineWorkflow({
  name: 'test-kind-trace',
  code: 'kt',
  inputSubject: 'pdf',
  systems: [{ id: 'sys', login: async () => {} }],
  steps: ['go'] as const,
  schema: z.object({ doc: z.string() }),
  handler: async (ctx) => { ctx.markStep('go') },
})

function readRows(dir: string): Array<{ status: string; data?: Record<string, string> }> {
  const file = readdirSync(rowsDir(dir)).find(
    (f) => f.startsWith('test-kind-trace-') && f.endsWith('.jsonl'),
  )
  assert.ok(file, 'tracker jsonl file should exist')
  return readFileSync(join(rowsDir(dir), file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

test('runWorkflow seeds queueRowKind + __traceId onto every row (not just pending)', async () => {
  const dir = TMP()
  await runWorkflow(wf, { doc: 'scan.pdf' }, {
    launchFn: fakeLaunch,
    trackerDir: dir,
    preAssignedRunId: 'aaaabbbb-1111-2222-3333-444455556666',
  })

  const rows = readRows(dir)
  const live = rows.filter((r) => r.status === 'running' || r.status === 'done')
  assert.ok(live.length > 0, 'should have at least one running/done row')
  for (const row of live) {
    assert.equal(row.data?.queueRowKind, 'file', `live row (${row.status}) must carry queueRowKind`)
    assert.match(row.data?.__traceId ?? '', /^kt-\d{6}-aaaa$/, `live row (${row.status}) must carry a kt-prefixed trace id`)
  }
})

test('runWorkflow reuses the trace id frozen on the run\'s pending row (delegation case)', async () => {
  const dir = TMP()
  const runId = 'ccccdddd-1111-2222-3333-444455556666'
  const frozen = 'os-053126155123-cccc' // e.g. an OCR child pre-emitted by oath-signature (rootCode=os)

  // The delegate pre-emit already wrote a pending row carrying the frozen id.
  emitTrackerRow(
    {
      workflow: 'test-kind-trace',
      timestamp: new Date().toISOString(),
      id: 'item-1',
      runId,
      parentRunId: 'parent-1',
      status: 'pending',
      data: { archetype: 'preview', queueRowKind: 'file', __traceId: frozen },
    },
    dir,
  )

  await runWorkflow(wf, { doc: 'scan.pdf' }, {
    launchFn: fakeLaunch,
    trackerDir: dir,
    itemId: 'item-1',
    preAssignedRunId: runId,
    parentRunId: 'parent-1',
  })

  const rows = readRows(dir)
  const live = rows.filter((r) => r.status === 'running' || r.status === 'done')
  assert.ok(live.length > 0, 'should have at least one running/done row')
  for (const row of live) {
    assert.equal(row.data?.__traceId, frozen, `live row (${row.status}) must reuse the frozen trace id, not recompute`)
    assert.equal(row.data?.queueRowKind, 'file')
  }
})
