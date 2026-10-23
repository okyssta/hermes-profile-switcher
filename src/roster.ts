/**
 * Pure helpers for the profile roster — the rows the switcher shows and the
 * key that selects one.
 *
 * Kept free of React and of the SDK so it can be unit-tested headlessly
 * (tests/roster.test.mjs). Every function here is total: it never throws on
 * a malformed row, because the roster arrives over the wire from a gateway
 * that may be an older build than this plugin.
 */

/** One profile row as the backend reports it (profiles.list / /api/profiles). */
export interface ProfileRow {
  name: string
  path?: string
  is_default?: boolean
  model?: string | null
  provider?: string | null
  description?: string
  display_name?: string
  skill_count?: number
  /** Newest human-facing session, when the backend included sessions. */
  last_session?: {
    id?: string
    title?: string
    preview?: string
    started_at?: number | string
    last_active?: number | string
    message_count?: number
  } | null
  /** A profile working right now (kanban/tool worker). */
  worker_session?: { id?: string; title?: string; source?: string; last_active?: number } | null
  [key: string]: unknown
}

/** A row prepared for display. */
export interface RosterEntry {
  /** The profile's real name — what the backend addresses it by. */
  name: string
  /** What the row shows: the display name when set, else the name. */
  label: string
  isDefault: boolean
  /** The newest session's id, so a pick can land IN that conversation. */
  lastSessionId: string
  /** The newest session's title, for the second line. */
  lastTitle: string
  /** The newest session's preview text, trimmed to one line. */
  lastPreview: string
  /** When that session was last active (epoch ms), or 0. */
  lastActiveAt: number
  /** True when the profile has a worker session right now. */
  working: boolean
  /** The model the profile runs, when the backend reports one. */
  model: string
  skillCount: number
}

/** Normalize a profile name the way the app does: trimmed, lowercased. */
export function normalizeProfileKey(name: string): string {
  return (name ?? '').trim().toLowerCase()
}

/** Epoch ms from a value that may be seconds, millis, or a date string. */
function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below ~2001 in ms is really seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)

    if (Number.isFinite(parsed)) {
      return parsed
    }

    const numeric = Number(value)

    if (Number.isFinite(numeric)) {
      return toEpochMs(numeric)
    }
  }

  return 0
}

/** Collapse whitespace and cut to one line, for a preview row. */
function oneLine(text: unknown, max = 140): string {
  if (typeof text !== 'string') {
    return ''
  }

  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Prepare the roster for display.
 *
 * The DEFAULT profile always sorts first — it is the app's home profile and
 * every other profile is a satellite of it. Named profiles keep the order the
 * backend returned (which is the app's own rail order), so the switcher's
 * row N lines up with the profile rail's row N.
 */
export function buildRoster(rows: readonly ProfileRow[] | null | undefined): RosterEntry[] {
  if (!Array.isArray(rows)) {
    return []
  }

  const entries: RosterEntry[] = []

  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) {
      continue
    }

    const last = row.last_session ?? null
    const worker = row.worker_session ?? null

    entries.push({
      name: row.name.trim(),
      label: (typeof row.display_name === 'string' && row.display_name.trim()) || row.name.trim(),
      isDefault: row.is_default === true,
      lastSessionId: typeof last?.id === 'string' ? last.id.trim() : '',
      lastTitle: oneLine(last?.title, 80),
      lastPreview: oneLine(last?.preview, 140),
      lastActiveAt: toEpochMs(last?.last_active ?? last?.started_at),
      working: Boolean(worker),
      model: typeof row.model === 'string' ? row.model : '',
      skillCount: typeof row.skill_count === 'number' ? row.skill_count : 0
    })
  }

  const isDefault = entries.find(entry => entry.isDefault)
  const named = entries.filter(entry => !entry.isDefault)

  return isDefault ? [isDefault, ...named] : named
}

/**
 * Index of the row a switch should land on.
 *
 * Starts at the current profile so the first Tab does not move (the macOS
 * switcher behaves the same way: the first press highlights the current
 * window). Wraps at both end.
 */
export function nextIndex(current: number, direction: 1 | -1, length: number): number {
  if (length <= 0) {
    return 0
  }

  const start = current < 0 ? (direction === 1 ? -1 : 0) : current

  return ((start + direction) % length + length) % length
}

/**
 * The row index of `profileName`, or -1 when it is not in the roster.
 *
 * Matching is case-insensitive because the app normalizes profile keys.
 */
export function indexOfProfile(entries: readonly RosterEntry[], profileName: string): number {
  const key = normalizeProfileKey(profileName)

  return entries.findIndex(entry => normalizeProfileKey(entry.name) === key)
}

/**
 * Filter the roster by a typed query.
 *
 * Matches the profile name, its display name, and the newest session's
 * title — so "research" finds the profile named `research`, the one
 * displayed as "Research", and the one whose last conversation was about
 * research.
 */
export function filterRoster(entries: readonly RosterEntry[], query: string): RosterEntry[] {
  const needle = (query ?? '').trim().toLowerCase()

  if (!needle) {
    return [...entries]
  }

  return entries.filter(entry =>
    [entry.name, entry.label, entry.lastTitle, entry.lastPreview].some(text =>
      (text ?? '').toLowerCase().includes(needle)
    )
  )
}
