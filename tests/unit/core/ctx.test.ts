import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeCtx } from '../../../src/core/kernel/ctx.js'
import { Session } from '../../../src/core/kernel/session.js'
import { Stepper } from '../../../src/core/kernel/stepper.js'

test('makeCtx returns a Ctx with page/step/parallel/updateData/session bound', () => {
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
  })
  const ctx = makeCtx({
    session,
    stepper,
    isBatch: true,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
  })

  assert.equal(typeof ctx.page, 'function')
  assert.equal(typeof ctx.step, 'function')
  assert.equal(typeof ctx.parallel, 'function')
  assert.equal(typeof ctx.updateData, 'function')
  assert.equal(ctx.isBatch, true)
  assert.equal(ctx.runId, 'r1')
  assert.equal(typeof ctx.session.page, 'function')
  assert.equal(typeof ctx.screenshot, 'function')
})

test('captureAndStampScreenshot captures a form screenshot and stamps first filename', async () => {
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
  })
  const ctx = makeCtx({
    session,
    stepper,
    isBatch: false,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
  })
  ctx.screenshot = async (opts) => {
    assert.deepEqual(opts, { kind: 'form', label: 'person-org-summary' })
    return {
      type: 'screenshot',
      runId: 'r1',
      ts: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      kind: 'form',
      label: 'person-org-summary',
      step: null,
      files: [{ system: 'ucpath', path: '/tmp/person-org.png' }],
    }
  }

  await ctx.captureAndStampScreenshot('person-org-summary', 'personOrgScreenshot')

  assert.equal(ctx.data.personOrgScreenshot, 'person-org.png')
})
