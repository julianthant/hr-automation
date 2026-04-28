import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'
import { dateLocal } from '../../../src/tracker/jsonl.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTrackerEntries(dir: string, workflow: string): Array<Record<string, unknown>> {
  const today = dateLocal()
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

test('updateData preserves Date ISO string in tracker entry', async (t) => {
  const wfName = `updatedata-date-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = mkdtempSync(join(tmpdir(), "updatedata-"))
  t.after(() => cleanupDir(tmp))

  const when = new Date('2026-04-17T12:34:56.000Z')
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    handler: async (ctx) => {
      ctx.updateData({ when })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'a' }, {
    itemId: 'item-1',
    launchFn: () => Promise.resolve(fakeSlot()), trackerDir: tmp,
  })

  const entries = readTrackerEntries(tmp, wfName)
  // Find a running or done entry that holds the merged data.
  const withWhen = entries.find((e) => {
    const d = e.data as Record<string, string> | undefined
    return d && typeof d.when === 'string' && d.when.length > 0
  })
  assert.ok(withWhen, `expected a tracker entry containing 'when', got: ${JSON.stringify(entries)}`)
  const d = withWhen.data as Record<string, string>
  assert.equal(d.when, when.toISOString())
})

test('updateData stringifies objects via JSON.stringify', async (t) => {
  const wfName = `updatedata-obj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = mkdtempSync(join(tmpdir(), "updatedata-"))
  t.after(() => cleanupDir(tmp))

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    handler: async (ctx) => {
      ctx.updateData({ obj: { a: 1, b: 2 } })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'b' }, {
    itemId: 'item-2',
    launchFn: () => Promise.resolve(fakeSlot()), trackerDir: tmp,
  })

  const entries = readTrackerEntries(tmp, wfName)
  const withObj = entries.find((e) => {
    const d = e.data as Record<string, string> | undefined
    return d && typeof d.obj === 'string' && d.obj.startsWith('{')
  })
  assert.ok(withObj, `expected tracker entry containing 'obj', got: ${JSON.stringify(entries)}`)
  const d = withObj.data as Record<string, string>
  assert.equal(d.obj, '{"a":1,"b":2}')
})

test('updateData preserves primitives (number/boolean) as strings', async (t) => {
  const wfName = `updatedata-prim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = mkdtempSync(join(tmpdir(), "updatedata-"))
  t.after(() => cleanupDir(tmp))

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    handler: async (ctx) => {
      ctx.updateData({ n: 42, b: true, s: 'hello' })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'c' }, {
    itemId: 'item-3',
    launchFn: () => Promise.resolve(fakeSlot()), trackerDir: tmp,
  })

  const entries = readTrackerEntries(tmp, wfName)
  const withAll = entries.find((e) => {
    const d = e.data as Record<string, string> | undefined
    return d && d.n === '42' && d.b === 'true' && d.s === 'hello'
  })
  assert.ok(withAll, `expected tracker entry with primitives, got: ${JSON.stringify(entries)}`)
})

test('updateData co-emits typedData alongside string data', async (t) => {
  const wfName = `updatedata-typed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = mkdtempSync(join(tmpdir(), "updatedata-"))
  t.after(() => cleanupDir(tmp))

  const when = new Date('2026-04-17T12:34:56.000Z')
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    handler: async (ctx) => {
      ctx.updateData({ wage: 12.5, active: true, start: when, label: 'Full Time' })
      await ctx.step('only', async () => {})
    },
  })

  await runWorkflow(wf, { k: 'a' }, {
    itemId: 'item-1',
    launchFn: () => Promise.resolve(fakeSlot()), trackerDir: tmp,
  })

  const entries = readTrackerEntries(tmp, wfName)
  const withTyped = entries.find((e) => {
    const td = e.typedData as Record<string, { type: string; value: string }> | undefined
    return td && td.wage?.type === 'number'
  })
  assert.ok(withTyped, `expected an entry with typedData, got: ${JSON.stringify(entries)}`)
  const td = withTyped.typedData as Record<string, { type: string; value: string }>
  assert.deepEqual(td.wage, { type: 'number', value: '12.5' })
  assert.deepEqual(td.active, { type: 'boolean', value: 'true' })
  assert.deepEqual(td.start, { type: 'date', value: when.toISOString() })
  assert.deepEqual(td.label, { type: 'string', value: 'Full Time' })
})
