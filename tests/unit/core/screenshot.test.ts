import test from 'node:test'
import assert from 'node:assert/strict'
import { makeScreenshotFn } from '../../../src/core/screenshot.js'

test('captures files and emits screenshot event with current step', async () => {
  const emitted: any[] = []
  const fakeSession = {
    captureAll: async (opts: any) => [
      { system: 'kuali', path: `/tmp/${opts.label}-kuali.png`, bytes: 42 },
      { system: 'ucpath', path: `/tmp/${opts.label}-ucpath.png`, bytes: 42 },
    ],
  }
  const fn = makeScreenshotFn({
    session: fakeSession as any,
    runId: 'run-1',
    workflow: 'separations',
    itemId: '3907',
    emit: (e) => { emitted.push(e) },
    currentStep: () => 'kuali-finalization',
  })
  const cap = await fn({ kind: 'form', label: 'kuali-finalization-saved' })
  assert.equal(cap.kind, 'form')
  assert.equal(cap.step, 'kuali-finalization')
  assert.equal(cap.files.length, 2)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'screenshot')
  assert.equal(emitted[0].runId, 'run-1')
  assert.equal(emitted[0].kind, 'form')
  assert.equal(emitted[0].step, 'kuali-finalization')
})

test('emit errors are swallowed — capture still returns the record', async () => {
  const fn = makeScreenshotFn({
    session: { captureAll: async () => [] } as any,
    runId: 'run-1',
    workflow: 'wf',
    itemId: 'i',
    emit: () => { throw new Error('boom') },
    currentStep: () => null,
  })
  const cap = await fn({ kind: 'error', label: 'test' })
  assert.equal(cap.label, 'test')
})
