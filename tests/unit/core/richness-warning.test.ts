import { test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/kernel/workflow.js'
import { captureLogWarn, detailFieldNeverPopulatedWarnings } from '../../_utils/capture-warn.js'

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

test('runtime warning: declared detailFields never populated emit one warn each', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'richness-warn-'))
  t.onTestFinished(() => cleanupDir(tmp))

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

  const { warnings } = await captureLogWarn(() =>
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'warn-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )

  const missingWarnings = detailFieldNeverPopulatedWarnings(warnings)
  assert.equal(missingWarnings.length, 2, `expected 2 missing-field warns, got: ${JSON.stringify(missingWarnings)}`)
  assert.ok(missingWarnings.some((m) => m.includes("'missingKey'")))
  assert.ok(missingWarnings.some((m) => m.includes("'anotherMissing'")))
  // Populated key must NOT be flagged.
  assert.ok(!missingWarnings.some((m) => m.includes("'populatedKey'")))
})

test('ISS-004 pin: conditional: true detailField left unpopulated produces NO warn', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'richness-conditional-'))
  t.onTestFinished(() => cleanupDir(tmp))

  const wf = defineWorkflow({
    name: `richness-conditional-${Date.now()}`,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    detailFields: [
      { key: 'alwaysPopulated', label: 'Always' },
      { key: 'conditionalField', label: 'Conditional', conditional: true },
      { key: 'normalMissing', label: 'Normal Missing' },
    ],
    handler: async (ctx) => {
      ctx.updateData({ alwaysPopulated: 'yes' })
      // conditionalField is intentionally NOT populated (simulates inactive employee path)
      // normalMissing is intentionally NOT populated (a genuinely dead field)
      await ctx.step('only', async () => {})
    },
  })

  const { warnings } = await captureLogWarn(() =>
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'conditional-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )

  const missingWarnings = detailFieldNeverPopulatedWarnings(warnings)
  // normalMissing MUST warn (non-conditional, unpopulated)
  assert.ok(missingWarnings.some((m) => m.includes("'normalMissing'")),
    `expected warn for 'normalMissing', got: ${JSON.stringify(missingWarnings)}`)
  // conditionalField must NOT warn (conditional: true, unpopulated is legitimate)
  assert.ok(!missingWarnings.some((m) => m.includes("'conditionalField'")),
    `expected NO warn for 'conditionalField', got: ${JSON.stringify(missingWarnings)}`)
  // alwaysPopulated must NOT warn (it was populated)
  assert.ok(!missingWarnings.some((m) => m.includes("'alwaysPopulated'")),
    `expected NO warn for 'alwaysPopulated', got: ${JSON.stringify(missingWarnings)}`)
  assert.equal(missingWarnings.length, 1,
    `expected exactly 1 warn (normalMissing), got: ${JSON.stringify(missingWarnings)}`)
})

test('runtime warning: no warning when all declared fields populated', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'richness-ok-'))
  t.onTestFinished(() => cleanupDir(tmp))

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

  const { warnings } = await captureLogWarn(() =>
    runWorkflow(wf, { k: 'a' }, {
      itemId: 'ok-1',
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
    }),
  )

  const missingWarnings = detailFieldNeverPopulatedWarnings(warnings)
  assert.equal(missingWarnings.length, 0, `expected no warns, got: ${JSON.stringify(missingWarnings)}`)
})
