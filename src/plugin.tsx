/**
 * Profile switcher — a macOS-style quick switcher for Hermes profiles.
 *
 * The idea is the app switcher: one gesture opens a panel of every profile,
 * you move the highlight, and you land on the one you pick. Hermes Desktop
 * already ships positional profile hotkeys (⌘1…⌘9), but there is no
 * "browse every profile and jump to one" surface, and no chord for it at all.
 * That is the gap this plugin fills.
 *
 * Two ways in:
 *
 *  1. **The app-switcher gesture** — hold ⌃⌥ and tap Tab to cycle, release to
 *     land. This is the Alt+Tab interaction. It cannot be bound to literal
 *     Alt+Tab or Win+Tab: the OS owns those chords and never delivers them to
 *     the renderer, which is why the gesture lives on `ctrl+alt+tab` — a chord
 *     no OS and no Hermes core action claims.
 *  2. **A contributed keybind** (⌥⌘P / ⌃⌥P) plus a status-bar chip, for a
 *     single-press open with a click or the keyboard.
 *
 * The switch itself goes through `host.openSession` with an explicit profile,
 * which is the app's own profile-switch path: it activates that profile's
 * backend, scopes the chrome onto it, and lands on that profile's most recent
 * conversation. A profile with no conversation gets a fresh draft instead.
 *
 * State lives in module-level atoms (the SDK exports `atom` / `computed`),
 * NOT in React hooks inside `register(ctx)` — `register` is not a component,
 * so a hook called there would throw. The keyboard listeners are installed
 * through `ctx.addEventListener`, which the SDK tears down on reload/disable,
 * so nothing keeps firing after the plugin goes away.
 */

import {
  Badge,
  Codicon,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  atom,
  computed,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef } from 'react'

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

/** The last roster the gateway gave us. Cached so a re-press is instant. */
const $roster = atom<ProfileRow[]>([])

/** Which row is highlighted. */
const $selected = atom(0)

/**
 * Was the panel opened by the hold-and-cycle gesture?
 *
 * Only then does releasing ⌃/⌥ commit. A panel opened with ⌃⌥P or the chip
 * must NOT switch anything when the modifier is let go — the user is still
 * choosing.
 */
const $holdMode = atom(false)

/** The visible rows: the roster filtered by the query. */
const $entries = computed([$roster, $query], (roster, query) => filterRoster(buildRoster(roster), query))

/**
 * The plugin's own settings.
 *
 * `ctx.storage` is the plugin-scoped door (`hermes.plugin.<id>.<key>` in
 * localStorage), so these survive a reload without the plugin owning a file
 * or reading a credential store.
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
 * `ctx.storage` is only available inside `register(ctx)`, so the module keeps
 * a reference to it. It is null before registration and after teardown, and
 * every read/write tolerates that — the plugin renders fine with the defaults
 * when the door is absent.
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
 * Load the roster.
 *
 * `profiles.list` is the gateway's own roster call: every profile with its
 * model, skill count, and — because `include_sessions` defaults on — the
 * newest conversation per profile. It is the same call the app's own profile
 * rail and the Bots roster use, so this list is always the app's list.
 *
 * Fetched on open, never on a timer: a plugin that polls the gateway is a
 * background process the user never asked for. Concurrent calls share one
 * in-flight request, so mashing the gesture does not open a socket per tap.
 */
let inflight: Promise<void> | null = null

function refreshRoster(): Promise<void> {
  if (inflight) {
    return inflight
  }

  inflight = (async () => {
    try {
      const result = (await host.request('profiles.list', { include_sessions: true })) as {
        profiles?: ProfileRow[]
      }

      $roster.set(Array.isArray(result?.profiles) ? result.profiles : [])
    } catch {
      // Keep the last good roster: a transient gateway error should not
      // empty a panel the user is mid-gesture in.
    }
  })().finally(() => {
    inflight = null
  })

  return inflight
}

/** The profile the live gateway is actually routed to. */
function activeProfileName(): string {
  return host.state.profile.get()
}

/** Open the switcher with the highlight on the profile you are already in. */
function openSwitcher(): void {
  $query.set('')
  $holdMode.set(false)
  pendingCycle = null
  void refreshRoster()

  const entries = $entries.get()
  const index = indexOfProfile(entries, activeProfileName())

  $selected.set(index >= 0 ? index : 0)
  $switcherOpen.set(true)
}

/**
 * A cycle requested before the roster was known.
 *
 * The gesture can fire before `profiles.list` returns, and the "next profile"
 * answer depends on where the highlight started. Remembering the direction
 * lets us seat the highlight correctly once the rows arrive instead of
 * defaulting to the first row.
 */
let pendingCycle: 1 | -1 | null = null

/** Seat the highlight relative to the active profile, then step once. */
function seatAndAdvance(): void {
  const direction = pendingCycle ?? 1

  pendingCycle = null

  const entries = $entries.get()

  if (entries.length === 0) {
    return
  }

  const index = indexOfProfile(entries, activeProfileName())

  $selected.set(nextIndex(index >= 0 ? index : -1, direction, entries.length))
}

/**
 * The app-switcher gesture: `⇥` while ⌃⌥ is held.
 *
 * The first tap opens the panel and moves OFF the current profile — exactly
 * what Alt+Tab does. Later taps wrap around the list.
 */
function cycle(direction: 1 | -1): void {
  if ($switcherOpen.get()) {
    advance(direction)

    return
  }

  $query.set('')
  $holdMode.set(true)
  pendingCycle = direction
  $switcherOpen.set(true)

  if ($entries.get().length > 0) {
    // Warm cache: seat now so the panel appears already on the right row, and
    // refresh in the background so the list is current.
    seatAndAdvance()
    void refreshRoster()
  } else {
    void refreshRoster().then(seatAndAdvance)
  }
}

/** Move the highlight, wrapping at both ends. */
function advance(direction: 1 | -1): void {
  const length = $entries.get().length

  if (length === 0) {
    return
  }

  $selected.set(nextIndex($selected.get(), direction, length))
}

/** Close the switcher. */
function closeSwitcher(): void {
  $switcherOpen.set(false)
  $holdMode.set(false)
  $query.set('')
}

/**
 * Land on the highlighted profile.
 *
 * Awaits the roster if the gesture outran the fetch, so a fast tap-and-release
 * still lands somewhere rather than doing nothing.
 */
async function commitSelected(): Promise<void> {
  if (pendingCycle !== null) {
    await refreshRoster()
    seatAndAdvance()
  } else if ($roster.get().length === 0) {
    await refreshRoster()
  }

  const entry = $entries.get()[$selected.get()]

  if (entry) {
    pickProfile(entry)
  }
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
 * a background dial: the sidebar collapses onto the target profile instead of
 * staying in the all-profiles browse view.
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
 *
 * It is render-only. Every keystroke is handled by the listeners `register`
 * installs, so there is exactly one owner of the gesture and no chance of a
 * double-advance when the panel's own listener and the app's disagree.
 */
function SwitcherPanel() {
  const open = useValue($switcherOpen)
  const entries = useValue($entries)
  const selected = useValue($selected)
  const settings = useValue($settings)
  const activeProfile = useValue(host.state.profile)

  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view when the selection moves.
  useEffect(() => {
    if (!open) {
      return
    }

    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])

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
          <span className="text-[0.6875rem] text-(--ui-text-quaternary)">
            ⌃⌥+Tab to cycle · Enter switch · Esc cancel
          </span>
        </div>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1" ref={listRef}>
          {entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-[0.8125rem] text-(--ui-text-quaternary)">
              No profiles found
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
    'An app-switcher for Hermes profiles: hold ⌃⌥ and tap Tab to cycle, release to land. Also ⌥⌘P, a status-bar chip, and a palette command.',
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

    /*
     * The app-switcher gesture.
     *
     * `ctrl+alt+tab` rather than `alt+tab` because the OS owns Alt+Tab (and
     * Win+Tab, and ⌘Tab): those keystrokes are consumed by the window manager
     * before the renderer sees them, so no in-app binding can ever fire. This
     * chord is unclaimed by both the OS and Hermes core.
     *
     * `ctx.addEventListener` is scoped: the SDK removes these on reload,
     * disable, and teardown, so a disabled plugin keeps no keyboard hooks.
     */
    if (typeof ctx.addEventListener === 'function') {
      ctx.addEventListener(
        window,
        'keydown',
        (event: KeyboardEvent) => {
          // Hold ⌃⌥, tap Tab to cycle. Ignore auto-repeat: one tap, one step.
          if (event.ctrlKey && event.altKey && event.code === 'Tab') {
            event.preventDefault()
            event.stopPropagation()

            if (!event.repeat) {
              cycle(event.shiftKey ? -1 : 1)
            }

            return
          }

          if (!$switcherOpen.get()) {
            return
          }

          if (event.key === 'Tab') {
            event.preventDefault()
            advance(event.shiftKey ? -1 : 1)

            return
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault()
            advance(1)

            return
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault()
            advance(-1)

            return
          }

          if (event.key === 'Enter') {
            event.preventDefault()
            void commitSelected()

            return
          }

          if (event.key === 'Escape') {
            event.preventDefault()
            closeSwitcher()
          }
        },
        { capture: true }
      )

      // Land on the highlighted profile when ⌃ or ⌥ is released — the
      // "release to switch" half of the gesture. Only for a gesture-opened
      // panel: ⌃⌥P and the chip stay put until you pick.
      ctx.addEventListener(
        window,
        'keyup',
        (event: KeyboardEvent) => {
          if (!$switcherOpen.get() || !$holdMode.get()) {
            return
          }

          if (event.key === 'Control' || event.key === 'Alt') {
            void commitSelected()
          }
        },
        { capture: true }
      )
    }

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
