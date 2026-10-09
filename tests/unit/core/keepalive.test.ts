import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runKeepaliveTick } from '../../../src/core/daemon/keepalive.js'
import type { Session } from '../../../src/core/kernel/session.js'
import type { SystemConfig } from '../../../src/core/kernel/types.js'

const systems: SystemConfig[] = [{ id: 'ukg', login: async () => {} }]

function fakeSession(healthCheck: (id: string) => Promise<boolean>): Session {
  return { healthCheck } as unknown as Session
}

test('runKeepaliveTick: a rejecting recoverOrphanedClaims does NOT throw (best-effort, daemon survives)', async () => {
  let healthChecked = false
  await assert.doesNotReject(
    runKeepaliveTick({
      instanceId: 'd1',
      session: fakeSession(async () => {
        healthChecked = true
        return true
      }),
      systems,
      recoverOrphanedClaims: async () => {
        throw new Error('transient sqlite hiccup')
      },
    }),
  )
  // Orphan-recovery failure is swallowed AND the health checks still ran — the
  // idle daemon must not be torn down by a transient recovery error.
  assert.equal(healthChecked, true, 'health checks run even after orphan recovery throws')
})

test('runKeepaliveTick: a rejecting healthCheck also does not throw (allSettled)', async () => {
  await assert.doesNotReject(
    runKeepaliveTick({
      instanceId: 'd1',
      session: fakeSession(async () => {
        throw new Error('health probe failed')
      }),
      systems,
      recoverOrphanedClaims: async () => 0,
    }),
  )
})
