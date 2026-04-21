import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { runWorkflowSharedContextPool } from '../../../src/core/shared-context-pool.js'

function fakeSlot() {
  return {
    page: {
      bringToFront: async () => {},
      context: () => ({ newPage: async () => ({ bringToFront: async () => {} }) }),
    } as unknown as import('playwright').Page,
    context: {
      close: async () => {},
      newPage: async () => ({ bringToFront: async () => {} }) as unknown as import('playwright').Page,
    } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTracker(dir: string, wf: string): any[] {
  const today = new Date().toISOString().slice(0, 10)
  const p = join(dir, `${wf}-${today}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
function readSessions(dir: string): any[] {
  const p = join(dir, 'sessions.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
function cleanup(dir: string) { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) }

test('runWorkflowSharedContextPool emits one workflow_start + one workflow_end(done) regardless of item count', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scp-one-instance-'))
  t.after(() => cleanup(tmp))
  const wfName = `scp-one-${Date.now()}`

  const wf = defineWorkflow({
    name: wfName,
    systems: [
      { id: 'ucpath', login: async () => {} },
      { id: 'crm', login: async () => {} },
    ],
    steps: ['s1'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async (ctx) => { await ctx.step('s1', async () => {}) },
  })

  const items = Array.from({ length: 4 }, (_, i) => ({ k: `k${i}` }))
  await runWorkflowSharedContextPool(wf, items, {
    launchFn: () => Promise.resolve(fakeSlot()),
    trackerDir: tmp,
  })

  const events = readSessions(tmp)
  const starts = events.filter((e) => e.type === 'workflow_start')
  const ends = events.filter((e) => e.type === 'workflow_end')
  assert.equal(starts.length, 1, 'exactly one workflow_start per batch')
  assert.equal(ends.length, 1, 'exactly one workflow_end per batch')
  assert.equal(ends[0].finalStatus, 'done')
})

test('runWorkflowSharedContextPool stamps pool instance on every item and injects per-system authTimings', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scp-authtimings-'))
  t.after(() => cleanup(tmp))
  const wfName = `scp-auth-${Date.now()}`

  const wf = defineWorkflow({
    name: wfName,
    systems: [
      { id: 'ucpath', login: async () => { await new Promise((r) => setTimeout(r, 20)) } },
      { id: 'crm', login: async () => { await new Promise((r) => setTimeout(r, 30)) } },
    ],
    steps: ['work'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    authSteps: true,
    handler: async (ctx) => { await ctx.step('work', async () => {}) },
  })

  await runWorkflowSharedContextPool(
    wf,
    [{ k: 'a' }, { k: 'b' }],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
      deriveItemId: (item: unknown) => (item as { k: string }).k,
    },
  )

  const entries = readTracker(tmp, wfName)
  const dones = entries.filter((e: any) => e.status === 'done')
  assert.equal(dones.length, 2, 'two done entries')
  const firstInstance = dones[0].data.instance
  assert.ok(firstInstance, 'instance stamped')
  assert.ok(dones.every((e: any) => e.data.instance === firstInstance), 'all items share pool instance')

  // Per-item auth steps with REAL recorded timestamps (not all identical)
  for (const id of ['a', 'b']) {
    const itemEntries = entries.filter((e: any) => e.id === id)
    const authUc = itemEntries.find((e: any) => e.step === 'auth:ucpath' && e.status === 'running')
    const authCrm = itemEntries.find((e: any) => e.step === 'auth:crm' && e.status === 'running')
    assert.ok(authUc, `item ${id} has auth:ucpath entry`)
    assert.ok(authCrm, `item ${id} has auth:crm entry`)
    assert.notEqual(authUc.timestamp, authCrm.timestamp, 'ucpath and crm entries have distinct timestamps')
  }

  const events = readSessions(tmp)
  const authStarts = events.filter((e: any) => e.type === 'auth_start')
  assert.equal(authStarts.length, 2, 'auth_start fires once per system (not per item)')
})
