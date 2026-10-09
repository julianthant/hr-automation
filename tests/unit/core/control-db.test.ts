import { test } from 'vitest'
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

    const journal = ctl.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    const busy = ctl.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    assert.equal(journal.journal_mode.toLowerCase(), 'wal')
    assert.ok(busy.timeout >= 5000)

    const version = ctl.db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as {
      version: number
    }
    assert.ok(version.version >= 4)
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
