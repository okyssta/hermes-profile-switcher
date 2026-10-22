/**
 * Profile switcher — a macOS-style quick switcher for Hermes profiles.
 *
 * The idea is the app switcher (⌘Tab): one chord opens a panel of every
 * profile, you move the highlight, and you land on the one you pick. Hermes
 * Desktop already ships positional profile hotkeys (⌘1…⌘9), but there is no
 * "browse every profile and jump to one" surface, and no chord for it at all.
 * That is the gap this plugin fills.
 *
 * Two surfaces:
 *
 *  1. A contributed keybind (⌥⌘P by default) opens the switcher.
 *  2. A status-bar chip naming the ACTIVE profile; clicking it opens the
 *     same switcher.
 *
 * The switch itself goes through `host.openSession` with an explicit profile,
 * which is the app's own profile-switch path: it activates that profile's
 * backend, scopes the chrome onto it, and lands on that profile's most recent
 * conversation. A profile with no conversation gets a fresh draft instead.
 *
 * State lives in module-level atoms (the SDK exports `atom`), NOT in React
 * hooks inside `register(ctx)` — `register` is not a component, so a hook
 * called there would throw. The hooks live in the components the plugin
 * registers, exactly like the app's own bundled plugins do.
 */

import {
  Badge,
  Codicon,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  atom,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildRoster,
  filterRoster,
  indexOfProfile,
  nextIndex,
  type ProfileRow,
  type RosterEntry
} from './roster'

/** The plugin id — the folder name and the export id must match. */
const ID = 'profile-switcher'

/** Is the switcher panel open? Module state, so a keybind and the chip agree. */
const $switcherOpen = atom(false)

/** The typed filter (empty = show everything). */
const $query = atom('')

/**
 * The plugin's own settings.
 *
 * `ctx.storage` is the plugin-scoped door (`hermes.plugin.<id>.<key>` in
 * localStorage), so these survive a reload without the plugin owning a
 * file or reading a credential store. The defaults here MUST match the
 * `config_schema` defaults in plugin.yaml — a schema key the plugin does not
 * read is a setting that silently does nothing.
 */
interface Settings {
  showModel: boolean
  showLastSession: boolean
}

const DEFAULT_SETTINGS: Settings = {
  showModel: true,
  showLastSession: true
}

/** The live settings. Seeded from storage at register time. */
const $settings = atom<Settings>(DEFAULT_SETTINGS)

/**
 * The storage door.
 *
 * `ctx.storage` is only available inside `register(ctx)`, so the module
 * keeps a reference to it. It is null before registration and after
 * teardown, and every read/write tolerates that — the plugin renders fine
 * with the defaults when the door is absent.
 */
let storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void } | null = null

const STORAGE_KEY = 'settings'

/** Read the persisted settings, falling back to the defaults. */
function readSettings(): Settings {
  if (!storage) {
    return DEFAULT_SETTINGS
  }

  try {
    const stored = storage.get<Partial<Settings>>(STORAGE_KEY, {})

    return {
      showModel: typeof stored?.showModel === 'boolean' ? stored.showModel : DEFAULT_SETTINGS.showModel,
      showLastSession:
        typeof stored?.showLastSession === 'boolean'
          ? stored.showLastSession
          : DEFAULT_SETTINGS.showLastSession
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Persist the settings. */
function writeSettings(settings: Settings): void {
  try {
    storage?.set(STORAGE_KEY, settings)
  } catch {
    // A full or unavailable localStorage must not break the switcher.
  }
}

/**
 * The roster query key.
 *
 * `profiles.list` is the gateway's own roster call: every profile with its
 * model, skill count, and — because `include_sessions` defaults on — the
 * newest conversation per profile. It is the same call the app's own profile
 * rail and the Bots roster use, so this list is always the app's list.
 */
const ROSTER_KEY = [ID, 'roster']

async function fetchRoster(): Promise<ProfileRow[]> {
  const result = (await host.request('profiles.list', { include_sessions: true })) as {
    profiles?: ProfileRow[]
  }

  return Array.isArray(result?.profiles) ? result.profiles : []
}

/** Open the switcher. */
function openSwitcher(): void {
  $query.set('')
  $switcherOpen.set(true)
}

/** Close the switcher. */
function closeSwitcher(): void {
  $switcherOpen.set(false)
  $query.set('')
}

/** Relative "last active" label — "now", "4m", "3h", "2d", else a date. */
function relativeLabel(epochMs: number): string {
  if (!epochMs) {
    return ''
  }

  const delta = Date.now() - epochMs

  if (delta < 0) {
    return 'now'
  }

  const minutes = Math.floor(delta / 60_000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h`
  }

  const days = Math.floor(hours / 24)

  if (days < 30) {
    return `${days}d`
  }

  return new Date(epochMs).toLocaleDateString()
}

/**
 * Land on a profile.
 *
 * `host.openSession` with an explicit `profile` is the app's own profile
 * switch: it activates that profile's backend and scopes the chrome onto it.
 * Passing the profile's most recent conversation id lands you IN that
 * conversation; a profile with no conversation gets a fresh draft.
 *
 * `keepAllProfilesScope: false` is what makes this a real SWITCH rather than
 * a background dial: the sidebar collapses onto the target profile instead
 * of staying in the all-profiles browse view.
 */
function pickProfile(entry: RosterEntry): void {
  closeSwitcher()

  const lastId = entry.lastSessionId

  if (lastId && typeof host.openSession === 'function') {
    void host
      .openSession(lastId, {
        expectHistory: false,
        keepAllProfilesScope: false,
        profile: entry.name
      })
      .catch((error: unknown) => {
        host.notifyError(error, `Could not switch to profile "${entry.name}"`)
      })

    return
  }

  // No conversation to resume: start a fresh chat in that profile.
  if (typeof host.newChat === 'function') {
    host.newChat(entry.name)

    return
  }

  host.notify({
    kind: 'error',
    message: 'This Hermes Desktop build cannot switch profiles. Update Hermes Desktop.'
  })
}

/** One row in the switcher. */
function ProfileRowView({
  active,
  entry,
  index,
  selected,
  showLastSession,
  showModel,
  onPick
}: {
  active: boolean
  entry: RosterEntry
  index: number
  selected: boolean
  showLastSession: boolean
  showModel: boolean
  onPick: () => void
}) {
  const last = relativeLabel(entry.lastActiveAt)
  const muted = selected ? 'text-(--ui-accent-foreground)/70' : 'text-(--ui-text-quaternary)'

  return (
    <button
      className={[
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
        selected
          ? 'bg-(--ui-accent) text-(--ui-accent-foreground)'
          : 'text-(--ui-text-secondary) hover:bg-(--ui-hover-surface)'
      ].join(' ')}
      data-selected={selected ? 'true' : 'false'}
      onClick={onPick}
      type="button"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[0.8125rem] font-medium">{entry.label}</span>
          {active ? <Badge variant="muted">active</Badge> : null}
          {entry.working ? <Codicon name="loading~spin" size="0.75rem" /> : null}
        </div>
        {showLastSession && entry.lastTitle ? (
          <div className={`truncate text-[0.6875rem] ${muted}`}>{entry.lastTitle}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {showModel && entry.model ? (
          <span className={`max-w-[9rem] truncate font-mono text-[0.625rem] ${muted}`} title={entry.model}>
            {entry.model}
          </span>
        ) : null}
        {last ? <span className={`text-[0.625rem] tabular-nums ${muted}`}>{last}</span> : null}
        <span
          className={[
            'w-4 text-right font-mono text-[0.625rem] tabular-nums',
            selected ? 'text-(--ui-accent-foreground)/70' : 'text-(--ui-text-tertiary)'
          ].join(' ')}
        >
          {index < 9 ? String(index + 1) : ''}
        </span>
      </div>
    </button>
  )
}

/**
 * The switcher panel.
 *
 * Rendered as a floating pane: it sits ABOVE the app's own surfaces (a
 * session, the settings page) instead of taking a slot in the layout tree.
 * That is what an overlay is — this is not a workspace.
 */
function SwitcherPanel() {
  const open = useValue($switcherOpen)
  const query = useValue($query)
  const settings = useValue($settings)
  const activeProfile = useValue(host.state.profile)

  // The roster is fetched when the panel opens, not on a timer: a plugin
  // that polls the gateway every few seconds is a background process the
  // user never asked for. React Query keeps the last roster cached, so a
  // reopen is instant and a cold open costs one request.
  const { data } = useQuery({
    queryFn: fetchRoster,
    queryKey: ROSTER_KEY,
    staleTime: 15_000
  })

  const roster = useMemo(() => buildRoster(data ?? []), [data])
  const entries = useMemo(() => filterRoster(roster, query), [roster, query])

  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Start the highlight on the ACTIVE profile, so the first Tab moves off it
  // rather than jumping to the top of the list.
  useEffect(() => {
    if (!open) {
      return
    }

    const index = indexOfProfile(entries, activeProfile)

    setSelected(index >= 0 ? index : 0)
  }, [activeProfile, entries, open])

  // Keep the highlighted row in view when the selection moves.
  useEffect(() => {
    if (!open) {
      return
    }

    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])

  const move = useCallback(
    (direction: 1 | -1) => {
      setSelected(current => nextIndex(current, direction, entries.length))
    },
    [entries.length]
  )

  const commit = useCallback(() => {
    const entry = entries[selected]

    if (entry) {
      pickProfile(entry)
    }
  }, [entries, selected])

  // Arrow / Tab navigation and Enter-to-commit live here rather than on the
  // app's keybind layer, because the app's dispatcher owns Tab for its own
  // surfaces and the plugin's own panel has to win while it is open.
  useEffect(() => {
    if (!open) {
      return undefined
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        move(1)

        return
      }

      if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
        event.preventDefault()
        move(-1)

        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [commit, move, open])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* Click-away catcher: no dim, so the app behind stays readable. */}
      <div className="absolute inset-0" onMouseDown={closeSwitcher} />
      <div
        className={[
          'relative w-[min(30rem,calc(100vw-2rem))] overflow-hidden rounded-xl border',
          'border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous'
        ].join(' ')}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
          <span className="text-[0.8125rem] font-medium text-(--ui-text-primary)">Switch profile</span>
          <span className="text-[0.6875rem] text-(--ui-text-quaternary)">↑↓ move · Enter switch · Esc cancel</span>
        </div>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1" ref={listRef}>
          {entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-[0.8125rem] text-(--ui-text-quaternary)">
              {query ? `No profile matches "${query}"` : 'No profiles found'}
            </div>
          ) : (
            entries.map((entry, index) => (
              <ProfileRowView
                active={entry.name.toLowerCase() === activeProfile.toLowerCase()}
                entry={entry}
                index={index}
                key={entry.name}
                onPick={() => pickProfile(entry)}
                selected={index === selected}
                showLastSession={settings.showLastSession}
                showModel={settings.showModel}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The status-bar chip: the active profile, click to open the switcher.
 *
 * It reads `host.state.profile` — the profile the live gateway is routed to —
 * so it always names the profile the app is actually talking to, not a
 * remembered preference.
 */
function ProfileChip() {
  const profile = useValue(host.state.profile)

  return (
    <button
      className="inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
      onClick={openSwitcher}
      title={`Active profile: ${profile} — click to switch`}
      type="button"
    >
      <Codicon name="account" size="0.75rem" />
      <span className="font-mono">{profile}</span>
    </button>
  )
}

/**
 * The plugin's settings page (Settings ▸ Plugins).
 *
 * Two toggles, written through `ctx.storage` so they persist per plugin.
 */
function SettingsPage() {
  const settings = useValue($settings)

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }

    $settings.set(next)
    writeSettings(next)
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <label className="flex items-center justify-between gap-4">
        <span>
          Show model
          <span className="block text-[0.6875rem] text-(--ui-text-quaternary)">
            Show each profile&rsquo;s model slug in the switcher row
          </span>
        </span>
        <input
          checked={settings.showModel}
          onChange={event => update({ showModel: event.target.checked })}
          type="checkbox"
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>
          Show last conversation
          <span className="block text-[0.6875rem] text-(--ui-text-quaternary)">
            Show the title of each profile&rsquo;s most recent conversation
          </span>
        </span>
        <input
          checked={settings.showLastSession}
          onChange={event => update({ showLastSession: event.target.checked })}
          type="checkbox"
        />
      </label>
    </div>
  )
}

export default {
  id: ID,
  name: 'Profile Switcher',
  description:
    'A macOS-style quick switcher for Hermes profiles: one chord opens a panel of every profile, with its model and last conversation, and lands you on the one you pick.',
  defaultEnabled: false,
  register(ctx: any) {
    // Seed the settings from the plugin's own storage door.
    storage = ctx.storage ?? null
    $settings.set(readSettings())

    ctx.registerMany([
      // The switcher panel. A floating pane renders above the app's own
      // surfaces; it is mounted always but renders nothing until opened, so
      // it is not a permanent card in the corner.
      {
        id: 'switcher',
        area: 'panes',
        data: {
          placement: 'floating',
          anchor: 'top-right',
          width: '26rem',
          height: 'auto'
        },
        title: 'Switch profile',
        render: () => <SwitcherPanel />
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => <ProfileChip />
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'profile-switcher.open',
          label: 'Switch profile…',
          keywords: ['profile', 'switch', 'workspace', 'context', 'agent'],
          run: openSwitcher
        }
      },
      // The keybind: ⌥⌘P opens the switcher. It is CONTRIBUTED, so it appears
      // in the app's own keybind panel and the user can rebind or clear it
      // like any other shortcut. `mod+alt+p` is free: core uses `mod+alt`
      // only for the profile slots 10-18 (`mod+alt+1…9`) and `mod+alt+t`.
      {
        id: 'keybind',
        area: KEYBINDS_AREA,
        data: {
          id: 'profile-switcher.open',
          category: 'profiles',
          defaults: ['mod+alt+p'],
          label: 'Switch profile…',
          run: openSwitcher
        }
      }
    ])

    // Settings ▸ Plugins page. `ctx.registerSettingsPage` is the app's own
    // settings seam — the page appears under the plugin's own entry.
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({
        id: 'settings',
        title: 'Profile Switcher',
        icon: 'account',
        render: () => <SettingsPage />
      })
    }

    ctx.onDispose(() => {
      closeSwitcher()
      storage = null
    })
  }
}
