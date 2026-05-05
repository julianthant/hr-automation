import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openControlDb } from '../../../src/core/control-db.js'

test('control db migrates idempotently with WAL and busy timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-db-'))
  try {
    const path = join(dir, 'control.sqlite')
    const ctl = openControlDb({ path })
    ctl.migrate()
    ctl.migrate()

    assert.equal(ctl.db.pragma('journal_mode', { simple: true }), 'wal')
    assert.ok(Number(ctl.db.pragma('busy_timeout', { simple: true })) >= 5000)
    assert.equal(ctl.supportsUpdateReturning(), true)

    const version = ctl.db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as {
      version: number
    }
    assert.ok(version.version >= 3)
    assert.ok(
      ctl.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_commands'").get(),
    )
    assert.ok(
      ctl.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_processes'").get(),
    )

    ctl.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
