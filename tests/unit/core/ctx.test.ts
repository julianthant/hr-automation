import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx } from '../../../src/core/ctx.js'
import { Session } from '../../../src/core/session.js'
import { Stepper } from '../../../src/core/stepper.js'

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
