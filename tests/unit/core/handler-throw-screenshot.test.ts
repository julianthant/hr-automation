import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineWorkflow, runOneItem } from '../../../src/core/workflow.js'
import { Session } from '../../../src/core/session.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-handler-throw-'))

test('runOneItem: handler throwing outside ctx.step emits a screenshot event', async () => {
  const dir = TMP()
  const captures: Array<{ kind: string; label: string }> = []

  // Monkey-patch Session.captureAll to record calls without hitting Playwright.
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  ;(session as unknown as { captureAll: typeof session.captureAll }).captureAll = async (opts) => {
    captures.push({ kind: opts.kind, label: opts.label })
    return []
  }

  const wf = defineWorkflow({
    name: 'handler-throw-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['marker'] as const,
    schema: z.object({ id: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      ctx.markStep('marker')
      // Throw OUTSIDE ctx.step — this is the case the new hoist covers.
      throw new Error('synthetic post-step throw')
    },
  })

  const result = await runOneItem({
    wf,
    session,
    item: { id: 'x' },
    itemId: 'x',
    runId: 'run-x',
    trackerDir: dir,
    callerPreEmits: false,
  })

  assert.equal(result.ok, false, 'handler throw surfaces as ok:false')
  assert.equal(captures.length >= 1, true, 'at least one screenshot captured')
  assert.equal(captures[0].kind, 'error')
  assert.equal(captures[0].label, 'handler-throw')
})
