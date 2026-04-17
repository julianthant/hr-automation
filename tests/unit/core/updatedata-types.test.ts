import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'
import { DEFAULT_DIR } from '../../../src/tracker/jsonl.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTrackerEntries(workflow: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(DEFAULT_DIR, `${workflow}-${today}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function cleanup(workflow: string) {
  const today = new Date().toISOString().slice(0, 10)
  for (const suffix of [`.jsonl`, `-logs.jsonl`]) {
    const path = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`)
    if (existsSync(path)) rmSync(path)
  }
}

test('updateData preserves Date ISO string in tracker entry', async (t) => {
  const wfName = `updatedata-date-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => cleanup(wfName))

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
    launchFn: () => Promise.resolve(fakeSlot()),
  })

  const entries = readTrackerEntries(wfName)
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
  t.after(() => cleanup(wfName))

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
    launchFn: () => Promise.resolve(fakeSlot()),
  })

  const entries = readTrackerEntries(wfName)
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
  t.after(() => cleanup(wfName))

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
    launchFn: () => Promise.resolve(fakeSlot()),
  })

  const entries = readTrackerEntries(wfName)
  const withAll = entries.find((e) => {
    const d = e.data as Record<string, string> | undefined
    return d && d.n === '42' && d.b === 'true' && d.s === 'hello'
  })
  assert.ok(withAll, `expected tracker entry with primitives, got: ${JSON.stringify(entries)}`)
})
