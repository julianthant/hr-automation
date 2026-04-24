import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/index.js'
import type { SystemConfig } from '../../../src/core/types.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-initdata-'))

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

test('runWorkflow: initialData result merges into pending entry data', async () => {
  const dir = TMP()

  const wf = defineWorkflow({
    name: 'test-initdata',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['go'] as const,
    schema: z.object({ names: z.array(z.string()) }),
    authChain: 'sequential',
    detailFields: [{ key: 'summary', label: 'Summary' }],
    getName: (d) => d.summary ?? '',
    getId: (d) => d.summary ?? '',
    initialData: (input) => ({ summary: input.names.join('|'), count: input.names.length }),
    handler: async (ctx) => { ctx.markStep('go') },
  })

  await runWorkflow(wf, { names: ['Zaw', 'Thant'] }, { launchFn: fakeLaunch, trackerDir: dir })

  const files = readdirSync(dir).filter((f) => f.startsWith('test-initdata-') && f.endsWith('.jsonl') && !f.endsWith('-logs.jsonl'))
  assert.ok(files.length > 0, 'tracker jsonl file should exist')
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const pending = lines.find((l: any) => l.status === 'pending')
  assert.ok(pending, 'pending entry should exist')
  assert.equal(pending.data.summary, 'Zaw|Thant')
  assert.equal(pending.data.count, '2')
  assert.equal(pending.data.__name, 'Zaw|Thant', 'getName should have stamped __name from initialData')
  assert.equal(pending.data.__id, 'Zaw|Thant', 'getId should have stamped __id from initialData')
})

test('runWorkflow: without initialData, pending data.__name is empty', async () => {
  const dir = TMP()

  const wf = defineWorkflow({
    name: 'test-noinit',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['go'] as const,
    schema: z.object({ names: z.array(z.string()) }),
    authChain: 'sequential',
    getName: (d) => d.name ?? '',
    getId: (d) => d.name ?? '',
    handler: async (ctx) => { ctx.markStep('go') },
  })

  await runWorkflow(wf, { names: ['x'] }, { launchFn: fakeLaunch, trackerDir: dir })

  const files = readdirSync(dir).filter((f) => f.startsWith('test-noinit-') && f.endsWith('.jsonl') && !f.endsWith('-logs.jsonl'))
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const pending = lines.find((l: any) => l.status === 'pending')
  assert.ok(pending)
  assert.equal(pending.data.__name, '')
})
