import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyTxnNumberFilled } from '../../../../src/systems/kuali/navigate.js'

/**
 * Build a stub Page + locator pair.
 *
 * behavior:
 *   'match'           — locator.inputValue() always returns `expected` (first read passes)
 *   'empty-then-fills' — first inputValue() returns '', fill() sets it, second read returns value
 *   'always-wrong'    — inputValue() always returns '' regardless of fill()
 */
function makePageStub(behavior: 'match' | 'empty-then-fills' | 'always-wrong', expected: string) {
  let state = behavior === 'match' ? expected : ''
  const calls = { fill: 0, inputValue: 0 }

  const locator = {
    async inputValue() {
      calls.inputValue++
      return state
    },
    async fill(v: string, _opts?: unknown) {
      calls.fill++
      if (behavior === 'empty-then-fills') state = v
      // 'always-wrong': state stays ''
    },
  }

  // Page stub: getByRole returns the same locator for any call
  const page = {
    getByRole(_role: string, _opts?: unknown) {
      return locator
    },
    async waitForTimeout(_ms: number) {},
  }

  return { page, calls }
}

test('passes silently when field already matches expected value', async () => {
  const { page, calls } = makePageStub('match', 'T001234')
  await verifyTxnNumberFilled(page as any, 'T001234')
  assert.equal(calls.fill, 0, 'should not call fill when already correct')
  assert.equal(calls.inputValue, 1, 'should read the field once')
})

test('refills and passes when first read is empty but refill sticks', async () => {
  const { page, calls } = makePageStub('empty-then-fills', 'T001234')
  await verifyTxnNumberFilled(page as any, 'T001234')
  assert.equal(calls.fill, 1, 'should refill once')
  assert.equal(calls.inputValue, 2, 'should read twice (before and after refill)')
})

test('throws mismatch-before-save error when refill still yields wrong value', async () => {
  const { page } = makePageStub('always-wrong', 'T001234')
  await assert.rejects(
    () => verifyTxnNumberFilled(page as any, 'T001234'),
    (err: Error) => {
      assert.ok(err.message.includes('Transaction Number mismatch before save'), `unexpected message: ${err.message}`)
      return true
    },
  )
})
