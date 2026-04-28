import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTrackedWorkflow, dateLocal } from '../../../src/tracker/jsonl.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-preassigned-instance-'))

test('withTrackedWorkflow: preAssignedInstance skips workflow_start/end and stamps data.instance', async () => {
  const dir = TMP()
  await withTrackedWorkflow(
    'test-wf',
    'item-1',
    async (_setStep, _updateData) => {
      // body is a no-op
    },
    { dir, preAssignedInstance: 'Pool 1', preAssignedRunId: 'run-1' },
  )

  const sessionsPath = join(dir, 'sessions.jsonl')
  if (existsSync(sessionsPath)) {
    const events = readFileSync(sessionsPath, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
    const starts = events.filter((e: any) => e.type === 'workflow_start')
    const ends = events.filter((e: any) => e.type === 'workflow_end')
    assert.equal(starts.length, 0, 'no workflow_start emitted under preAssignedInstance')
    assert.equal(ends.length, 0, 'no workflow_end emitted under preAssignedInstance')
  }

  const today = dateLocal()
  const entries = readFileSync(join(dir, `test-wf-${today}.jsonl`), 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
  const done = entries.find((e: any) => e.status === 'done')
  assert.ok(done, 'emitted done tracker entry')
  assert.equal(done.data?.instance, 'Pool 1', 'data.instance reuses preAssignedInstance')
})

test('withTrackedWorkflow: preAssignedInstance also skips emitWorkflowEnd on error path', async () => {
  const dir = TMP()
  let caught: unknown
  try {
    await withTrackedWorkflow(
      'test-wf-err',
      'item-err',
      async () => {
        throw new Error('boom')
      },
      { dir, preAssignedInstance: 'Pool 1', preAssignedRunId: 'run-err' },
    )
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'error rethrown')

  const sessionsPath = join(dir, 'sessions.jsonl')
  if (existsSync(sessionsPath)) {
    const events = readFileSync(sessionsPath, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
    const ends = events.filter((e: any) => e.type === 'workflow_end')
    assert.equal(ends.length, 0, 'no workflow_end emitted under preAssignedInstance on error')
  }
})

test('withTrackedWorkflow: without preAssignedInstance, still emits workflow_start/end (unchanged)', async () => {
  const dir = TMP()
  await withTrackedWorkflow(
    'test-wf-legacy',
    'item-legacy',
    async () => {
      // no-op
    },
    { dir, preAssignedRunId: 'run-legacy' },
  )

  const events = readFileSync(join(dir, 'sessions.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
  const starts = events.filter((e: any) => e.type === 'workflow_start')
  const ends = events.filter((e: any) => e.type === 'workflow_end')
  assert.equal(starts.length, 1, 'legacy path still emits one start')
  assert.equal(ends.length, 1, 'legacy path still emits one end')
})
