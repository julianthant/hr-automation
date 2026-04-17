import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'
import { log } from '../../../src/utils/log.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function cleanupDir(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Capture calls to log.warn so we can assert the dashboard-contract warning
 * fires exactly once per missing declared detailField.
 */
function captureWarn<T>(fn: () => Promise<T>): Promise<{ warnings: string[]; result: T }> {
  const original = log.warn
  const warnings: string[] = []
  log.warn = (msg: string) => { warnings.push(msg) }
  return fn().then(
    (result) => { log.warn = original; return { warnings, result } },
    (err) => { log.warn = original; throw err },
  )
}

test('runtime warning: declared detailFields never populated emit one warn each', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'richness-warn-'))
  t.after(() => cleanupDir(tmp))

  const wf = defineWorkflow({
    name: `richness-warn-${Date.now()}`,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    detailFields: [
      { key: 'populatedKey', label: 'Populated' },
      { key: 'missingKey', label: 'Missing' },
      { key: 'anotherMissing', label: 'Another' },
    ],
    handler: async (ctx) => {
      ctx.updateData({ populatedKey: 'ok' })
      await ctx.step('only', async () => {})
    },
  })

  const { warnings } = await captureWarn(() =>
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'warn-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )

  const missingWarnings = warnings.filter((m) =>
    m.includes("detailField '") && m.includes('never populated'),
  )
  assert.equal(missingWarnings.length, 2, `expected 2 missing-field warns, got: ${JSON.stringify(missingWarnings)}`)
  assert.ok(missingWarnings.some((m) => m.includes("'missingKey'")))
  assert.ok(missingWarnings.some((m) => m.includes("'anotherMissing'")))
  // Populated key must NOT be flagged.
  assert.ok(!missingWarnings.some((m) => m.includes("'populatedKey'")))
})

test('runtime warning: no warning when all declared fields populated', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'richness-ok-'))
  t.after(() => cleanupDir(tmp))

  const wf = defineWorkflow({
    name: `richness-ok-${Date.now()}`,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    detailFields: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    handler: async (ctx) => {
      ctx.updateData({ a: '1', b: '2' })
      await ctx.step('only', async () => {})
    },
  })

  const { warnings } = await captureWarn(() =>
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'ok-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )

  const missingWarnings = warnings.filter((m) =>
    m.includes("detailField '") && m.includes('never populated'),
  )
  assert.equal(missingWarnings.length, 0, `expected no warns, got: ${JSON.stringify(missingWarnings)}`)
})
