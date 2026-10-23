/**
 * Unit tests for the pure roster helpers.
 *
 * Run with `npm test` (node --test). No dependencies, no DOM: the helpers
 * are pure functions over plain data, so they are testable headlessly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRoster, filterRoster, indexOfProfile, nextIndex, normalizeProfileKey } from '../src/roster.ts'

test('normalizeProfileKey trims and lowercases', () => {
  assert.equal(normalizeProfileKey('  Research  '), 'research')
  assert.equal(normalizeProfileKey('DEFAULT'), 'default')
  assert.equal(normalizeProfileKey(''), '')
})

test('buildRoster returns an empty list for junk input', () => {
  assert.deepEqual(buildRoster(null), [])
  assert.deepEqual(buildRoster(undefined), [])
  assert.deepEqual(buildRoster('nope'), [])
  assert.deepEqual(buildRoster([]), [])
})

test('buildRoster skips rows without a usable name', () => {
  const rows = buildRoster([{ name: '' }, { name: '   ' }, null, { name: 'ok' }])

  assert.deepEqual(
    rows.map(entry => entry.name),
    ['ok']
  )
})

test('buildRoster puts the default profile first', () => {
  const rows = buildRoster([
    { name: 'work', is_default: false },
    { name: 'default', is_default: true },
    { name: 'research', is_default: false }
  ])

  assert.deepEqual(
    rows.map(entry => entry.name),
    ['default', 'work', 'research']
  )
})

test('buildRoster keeps backend order for named profiles', () => {
  const rows = buildRoster([
    { name: 'default', is_default: true },
    { name: 'zeta' },
    { name: 'alpha' }
  ])

  assert.deepEqual(
    rows.map(entry => entry.name),
    ['default', 'zeta', 'alpha']
  )
})

test('buildRoster prefers display_name for the label', () => {
  const [entry] = buildRoster([{ name: 'work', display_name: 'Work Robot' }])

  assert.equal(entry.name, 'work')
  assert.equal(entry.label, 'Work Robot')
})

test('buildRoster falls back to the name when display_name is blank', () => {
  const [entry] = buildRoster([{ name: 'work', display_name: '   ' }])

  assert.equal(entry.label, 'work')
})

test('buildRoster reads the newest session id, title and preview', () => {
  const [entry] = buildRoster([
    {
      name: 'work',
      last_session: {
        id: 'sess-123',
        title: 'Refactor the parser',
        preview: 'we should\n  split this   up'
      }
    }
  ])

  assert.equal(entry.lastSessionId, 'sess-123')
  assert.equal(entry.lastTitle, 'Refactor the parser')
  assert.equal(entry.lastPreview, 'we should split this up')
})

test('buildRoster truncates a long preview to one line', () => {
  const [entry] = buildRoster([{ name: 'work', last_session: { preview: 'x'.repeat(400) } }])

  assert.equal(entry.lastPreview.length, 140)
  assert.ok(entry.lastPreview.endsWith('…'))
})

test('buildRoster converts epoch seconds to milliseconds', () => {
  const [entry] = buildRoster([{ name: 'work', last_session: { last_active: 1_700_000_000 } }])

  assert.equal(entry.lastActiveAt, 1_700_000_000_000)
})

test('buildRoster keeps epoch milliseconds as they are', () => {
  const [entry] = buildRoster([{ name: 'work', last_session: { last_active: 1_700_000_000_000 } }])

  assert.equal(entry.lastActiveAt, 1_700_000_000_000)
})

test('buildRoster parses an ISO timestamp', () => {
  const [entry] = buildRoster([{ name: 'work', last_session: { last_active: '2024-01-02T03:04:05Z' } }])

  assert.equal(entry.lastActiveAt, Date.parse('2024-01-02T03:04:05Z'))
})

test('buildRoster tolerates a junk timestamp', () => {
  const [entry] = buildRoster([{ name: 'work', last_session: { last_active: 'not a date' } }])

  assert.equal(entry.lastActiveAt, 0)
})

test('buildRoster flags a working profile', () => {
  const [busy] = buildRoster([{ name: 'work', worker_session: { id: 'w1' } }])
  const [idle] = buildRoster([{ name: 'work', worker_session: null }])

  assert.equal(busy.working, true)
  assert.equal(idle.working, false)
})

test('nextIndex wraps forward past the end', () => {
  assert.equal(nextIndex(2, 1, 3), 0)
  assert.equal(nextIndex(0, 1, 3), 1)
})

test('nextIndex wraps backward past the start', () => {
  assert.equal(nextIndex(0, -1, 3), 2)
  assert.equal(nextIndex(2, -1, 3), 1)
})

test('nextIndex returns 0 for an empty list', () => {
  assert.equal(nextIndex(0, 1, 0), 0)
})

test('indexOfProfile matches case-insensitively', () => {
  const rows = buildRoster([
    { name: 'default', is_default: true },
    { name: 'Work' }
  ])

  assert.equal(indexOfProfile(rows, 'work'), 1)
  assert.equal(indexOfProfile(rows, 'WORK'), 1)
  assert.equal(indexOfProfile(rows, 'missing'), -1)
})

test('filterRoster returns everything for an empty query', () => {
  const rows = buildRoster([{ name: 'a' }, { name: 'b' }])

  assert.equal(filterRoster(rows, '').length, 2)
  assert.equal(filterRoster(rows, '   ').length, 2)
})

test('filterRoster matches the profile name', () => {
  const rows = buildRoster([{ name: 'research' }, { name: 'work' }])

  assert.deepEqual(
    filterRoster(rows, 'rese').map(entry => entry.name),
    ['research']
  )
})

test('filterRoster matches the display name', () => {
  const rows = buildRoster([{ name: 'bot-1', display_name: 'Research Agent' }, { name: 'work' }])

  assert.deepEqual(
    filterRoster(rows, 'research').map(entry => entry.name),
    ['bot-1']
  )
})

test('filterRoster matches the last session title', () => {
  const rows = buildRoster([
    { name: 'a', last_session: { title: 'Rust async deep dive' } },
    { name: 'b' }
  ])

  assert.deepEqual(
    filterRoster(rows, 'async').map(entry => entry.name),
    ['a']
  )
})

test('filterRoster returns nothing for a non-matching query', () => {
  const rows = buildRoster([{ name: 'a' }])

  assert.deepEqual(filterRoster(rows, 'zzz'), [])
})
