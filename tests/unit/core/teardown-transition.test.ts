import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  resolveTeardownTransition,
  type TeardownAction,
} from '../../../src/core/daemon/teardown-transition.js'

// Base: a deliberate cancel (neither stop flag set).
const base = {
  reassignInFlight: false,
  forceShutdown: false,
  hasTaskId: true,
  responsivePeerCount: 0,
  pidAlivePeerCount: 0,
}

function resolve(over: Partial<typeof base>): TeardownAction {
  return resolveTeardownTransition({ ...base, ...over })
}

test('reassign: reassignInFlight + a responsive peer + a taskId → reassign', () => {
  assert.deepEqual(
    resolve({ reassignInFlight: true, responsivePeerCount: 1, pidAlivePeerCount: 1, hasTaskId: true }),
    { kind: 'reassign' },
  )
})

test('fail no-responsive-peer: reassignInFlight + pid-alive peers but NONE responsive (F5)', () => {
  assert.deepEqual(
    resolve({ reassignInFlight: true, responsivePeerCount: 0, pidAlivePeerCount: 2, hasTaskId: true }),
    { kind: 'fail', reason: 'no-responsive-peer' },
  )
})

test('fail no-daemon: force-shutdown with no spare', () => {
  assert.deepEqual(
    resolve({ forceShutdown: true, responsivePeerCount: 0, pidAlivePeerCount: 0 }),
    { kind: 'fail', reason: 'no-daemon' },
  )
})

test('cancel: neither flag set (deliberate /cancel-current or browser-disconnect)', () => {
  assert.deepEqual(resolve({}), { kind: 'cancel' })
})

test('reassign requires a taskId: responsive peer but no taskId → falls through to cancel (no force)', () => {
  // reassignInFlight + a responsive peer but hasTaskId=false: not reassignable,
  // and with no pid-alive peers and no force, it is a cancel (mirrors the
  // claim-loop/sweep else branch).
  assert.deepEqual(
    resolve({ reassignInFlight: true, responsivePeerCount: 1, pidAlivePeerCount: 0, hasTaskId: false }),
    { kind: 'cancel' },
  )
})

test('reassign without taskId but pid-alive peers → fail no-responsive-peer (F5, not reassign)', () => {
  assert.deepEqual(
    resolve({ reassignInFlight: true, responsivePeerCount: 1, pidAlivePeerCount: 2, hasTaskId: false }),
    { kind: 'fail', reason: 'no-responsive-peer' },
  )
})

test('reassign takes precedence over force when both flags + a responsive peer are set', () => {
  assert.deepEqual(
    resolve({
      reassignInFlight: true,
      forceShutdown: true,
      responsivePeerCount: 1,
      pidAlivePeerCount: 1,
      hasTaskId: true,
    }),
    { kind: 'reassign' },
  )
})

test('reassignInFlight + zero peers + no force → cancel (last daemon, per-instance stop)', () => {
  // reassign requested but there is NO peer at all (responsive or pid-alive)
  // and force is not set → the claim-loop/sweep else (cancel). Faithful to the
  // pre-refactor chains, which fell through to the cancel branch here.
  assert.deepEqual(
    resolve({ reassignInFlight: true, responsivePeerCount: 0, pidAlivePeerCount: 0, hasTaskId: true }),
    { kind: 'cancel' },
  )
})

test('force beats cancel: forceShutdown set with no peers and no reassign → fail no-daemon', () => {
  assert.deepEqual(
    resolve({ forceShutdown: true, reassignInFlight: false }),
    { kind: 'fail', reason: 'no-daemon' },
  )
})
