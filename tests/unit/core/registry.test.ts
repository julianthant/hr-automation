import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, getAll, clear, getByName } from '../../../src/core/registry.js'

test('registry: register and retrieve metadata', () => {
  clear()
  register({ name: 'wf-a', steps: ['s1', 's2'], systems: ['ucpath'], detailFields: ['emplId'] })
  const all = getAll()
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'wf-a')
})

test('registry: register same name twice replaces', () => {
  clear()
  register({ name: 'wf-a', steps: ['s1'], systems: [], detailFields: [] })
  register({ name: 'wf-a', steps: ['s1', 's2'], systems: [], detailFields: [] })
  assert.equal(getAll().length, 1)
  assert.deepEqual(getByName('wf-a')?.steps, ['s1', 's2'])
})

test('registry: getByName returns undefined for unknown', () => {
  clear()
  assert.equal(getByName('unknown'), undefined)
})

test('registry: clear empties the store', () => {
  register({ name: 'wf-a', steps: ['s1'], systems: [], detailFields: [] })
  clear()
  assert.equal(getAll().length, 0)
})
