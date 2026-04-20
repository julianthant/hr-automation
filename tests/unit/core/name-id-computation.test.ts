import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTrackerEntries(workflow: string, dir: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(dir, `${workflow}-${today}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function cleanupDir(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

test('getName: stamped as data.__name on every emit', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'name-'))
  t.after(() => cleanupDir(tmp))

  const wfName = `get-name-${Date.now()}`
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    getName: (d) => `${d.first ?? ''} ${d.last ?? ''}`.trim(),
    handler: async (ctx) => {
      ctx.updateData({ first: 'Jane', last: 'Doe' })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'a' }, {
    itemId: 'name-1',
    launchFn: () => Promise.resolve(fakeSlot()),
    trackerDir: tmp,
  })

  const entries = readTrackerEntries(wfName, tmp)
  // Find the running entry for the 'only' step (auth:x may fire first without data yet).
  const running = entries.find((e) => e.status === 'running' && e.step === 'only')
  const d = running?.data as Record<string, string> | undefined
  assert.equal(d?.__name, 'Jane Doe')
})

test('getId: stamped as data.__id on every emit', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'id-'))
  t.after(() => cleanupDir(tmp))

  const wfName = `get-id-${Date.now()}`
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    getId: (d) => d.emplId ?? '',
    handler: async (ctx) => {
      ctx.updateData({ emplId: '99999' })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'a' }, {
    itemId: 'id-1',
    launchFn: () => Promise.resolve(fakeSlot()),
    trackerDir: tmp,
  })

  const entries = readTrackerEntries(wfName, tmp)
  // Find the running entry for the 'only' step (auth:x may fire first without data yet).
  const running = entries.find((e) => e.status === 'running' && e.step === 'only')
  const d = running?.data as Record<string, string> | undefined
  assert.equal(d?.__id, '99999')
})

test('getName throws: does not crash the workflow', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'name-throw-'))
  t.after(() => cleanupDir(tmp))

  const wfName = `name-throws-${Date.now()}`
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    getName: () => { throw new Error('oops') },
    handler: async (ctx) => {
      ctx.updateData({ first: 'Jane' })
      await ctx.step('only', async () => {})
    },
  })

  await assert.doesNotReject(
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'throw-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )
})
