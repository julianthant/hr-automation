import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, getAll, clear, getByName, autoLabel, normalizeDetailField, defineDashboardMetadata } from '../../../src/core/registry.js'

test('registry: register and retrieve metadata', () => {
  clear()
  register({
    name: 'wf-a',
    label: 'Wf A',
    steps: ['s1', 's2'],
    systems: ['ucpath'],
    detailFields: [{ key: 'emplId', label: 'Empl ID' }],
  })
  const all = getAll()
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'wf-a')
})

test('registry: register same name twice replaces', () => {
  clear()
  register({ name: 'wf-a', label: 'A', steps: ['s1'], systems: [], detailFields: [] })
  register({ name: 'wf-a', label: 'A', steps: ['s1', 's2'], systems: [], detailFields: [] })
  assert.equal(getAll().length, 1)
  assert.deepEqual(getByName('wf-a')?.steps, ['s1', 's2'])
})

test('registry: getByName returns undefined for unknown', () => {
  clear()
  assert.equal(getByName('unknown'), undefined)
})

test('registry: clear empties the store', () => {
  register({ name: 'wf-a', label: 'A', steps: ['s1'], systems: [], detailFields: [] })
  clear()
  assert.equal(getAll().length, 0)
})

test('registry: defineDashboardMetadata stores the same as register', () => {
  clear()
  defineDashboardMetadata({
    name: 'legacy-wf',
    label: 'Legacy',
    steps: ['a', 'b'],
    systems: ['x'],
    detailFields: [{ key: 'foo', label: 'Foo' }],
  })
  const got = getByName('legacy-wf')
  assert.ok(got)
  assert.equal(got?.name, 'legacy-wf')
  assert.equal(got?.label, 'Legacy')
})

test('registry: autoLabel handles camelCase + kebab-case', () => {
  assert.equal(autoLabel('employeeName'), 'Employee Name')
  assert.equal(autoLabel('emplId'), 'Empl Id')
  assert.equal(autoLabel('pdf-download'), 'Pdf Download')
  assert.equal(autoLabel('snake_case_key'), 'Snake Case Key')
  assert.equal(autoLabel('simple'), 'Simple')
})

test('registry: normalizeDetailField accepts string or labeled', () => {
  assert.deepEqual(normalizeDetailField('emplId'), { key: 'emplId', label: 'Empl Id' })
  assert.deepEqual(
    normalizeDetailField({ key: 'emplId', label: 'Empl ID' }),
    { key: 'emplId', label: 'Empl ID' },
  )
})
