import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runOneItem } from '../../../src/core/kernel/workflow.js'
import { Session } from '../../../src/core/kernel/session.js'
import { dateLocal } from '../../../src/tracker/jsonl.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-runone-'))

function readTracker(dir: string, workflow: string): any[] {
  const today = dateLocal()
  const p = join(dir, `${workflow}-${today}.jsonl`)
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('runOneItem: authTimings emitted as synthetic pre-handler tracker entries at recorded timestamps', async () => {
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'auth-inject-test',
    systems: [
      { id: 'ucpath', login: async () => {} },
      { id: 'crm', login: async () => {} },
    ],
    // auto-prepended steps are auth:ucpath, auth:crm
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: true,
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([
      ['ucpath', Promise.resolve()],
      ['crm', Promise.resolve()],
    ]),
  })

  const ucStart = Date.parse('2026-04-21T21:41:28.762Z')
  const crmStart = Date.parse('2026-04-21T21:41:45.000Z')
  await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-x',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Auth Inject Test 1',
    authTimings: [
      { systemId: 'ucpath', startTs: ucStart, endTs: ucStart + 16_000 },
      { systemId: 'crm', startTs: crmStart, endTs: crmStart + 29_000 },
    ],
  })

  const entries = readTracker(dir, 'auth-inject-test')

  const authUc = entries.find((e: any) => e.status === 'running' && e.step === 'auth:ucpath')
  const authCrm = entries.find((e: any) => e.status === 'running' && e.step === 'auth:crm')
  assert.ok(authUc, 'emitted auth:ucpath entry')
  assert.ok(authCrm, 'emitted auth:crm entry')
  assert.equal(authUc.timestamp, new Date(ucStart).toISOString(), 'uc timestamp matches recorded startTs')
  assert.equal(authCrm.timestamp, new Date(crmStart).toISOString(), 'crm timestamp matches recorded startTs')

  const done = entries.find((e: any) => e.status === 'done')
  assert.ok(done, 'emitted done entry')
  assert.equal(done?.data?.instance, 'Auth Inject Test 1', 'instance stamped')
})

test('runOneItem: without authTimings, no synthetic auth entries are emitted', async () => {
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'no-auth-inject-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: true,
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-noauth',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'No Auth Inject 1',
    // no authTimings
  })

  const entries = readTracker(dir, 'no-auth-inject-test')
  const authEntries = entries.filter((e: any) => typeof e.step === 'string' && e.step.startsWith('auth:'))
  assert.equal(authEntries.length, 0, 'no synthetic auth entries without authTimings')
})

test('runOneItem: force-stop requested during a Playwright failure records cancellation, not browser crash', async () => {
  const dir = TMP()
  let cancelRequested = false
  const wf = defineWorkflow({
    name: 'force-cancel-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      await ctx.step('searching', async () => {
        cancelRequested = true
        throw new Error('Browser closed unexpectedly')
      })
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const result = await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-force-cancel',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Force Cancel Test 1',
    isCancelRequested: () => cancelRequested,
  })

  assert.deepEqual(result, {
    ok: false,
    kind: 'cancelled',
    error: "Cancelled by user before step 'force-stop'",
  })
  const entries = readTracker(dir, 'force-cancel-test')
  const failed = entries.find((e: any) => e.status === 'failed')
  assert.equal(failed?.step, 'cancelled')
  assert.equal(failed?.error, "Cancelled by user before step 'force-stop'")
})
