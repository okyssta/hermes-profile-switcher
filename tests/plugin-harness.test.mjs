/**
 * Load-and-register harness for the desktop half.
 *
 * The Hermes Desktop app cannot run on a headless host, so this harness
 * stands in for it: it loads the BUILT `desktop/plugin.js` exactly as the
 * renderer's loader does (import map → ESM), calls `register(ctx)` against a
 * recording stub context, and renders every registered contribution.
 *
 * What this PROVES:
 *   - the built bundle loads as ESM with only the three allowed imports,
 *   - `register(ctx)` runs without throwing,
 *   - every contribution registers with the right area and payload,
 *   - the components render without throwing (a missing import in a `jsx()`
 *     call is a ReferenceError at RENDER time, not at load time — so the
 *     render step is the part that catches it).
 *
 * What this does NOT prove: the real Electron render, the real keybind
 * dispatch, and the real profile switch against a live gateway. Those need
 * the app.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The plugin registers its keyboard listeners on `window`. Node has no DOM,
// so stand one in: the plugin only hands it back to `ctx.addEventListener`,
// which records it rather than touching a real event target.
globalThis.window ??= globalThis

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..', 'desktop', 'plugin.js')

/** The three specifiers the Desktop loader resolves — nothing else. */
const ALLOWED_IMPORTS = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])

/**
 * A stub of the SDK surface the plugin uses.
 *
 * `atom` is the REAL nanostores atom (the SDK re-exports it), so the plugin's
 * module state behaves exactly as it does in the app. `useQuery`/`useValue`
 * are stubbed because rendering them needs React's renderer, which is not
 * in this harness's scope — the roster helpers are unit-tested separately.
 */
function makeSdkStub() {
  const listeners = new Map()

  const atom = initial => {
    let value = initial
    const subs = new Set()

    return {
      get: () => value,
      set: next => {
        const old = value

        value = next
        subs.forEach(listener => listener(value, old))
      },
      subscribe: listener => {
        subs.add(listener)

        return () => subs.delete(listener)
      }
    }
  }

  // The SDK re-exports nanostores' `computed`; derive eagerly and re-derive
  // whenever a dependency changes, which is what the app gets from nanostores.
  const computed = (stores, derive) => {
    const subs = new Set()
    let value = derive(...stores.map(store => store.get()))

    const recompute = () => {
      const next = derive(...stores.map(store => store.get()))

      if (!Object.is(next, value)) {
        const old = value

        value = next
        subs.forEach(listener => listener(value, old))
      }
    }

    stores.forEach(store => store.subscribe(recompute))

    return {
      get: () => value,
      subscribe: listener => {
        subs.add(listener)

        return () => subs.delete(listener)
      }
    }
  }

  return {
    __atoms: listeners,
    atom,
    computed,
    Badge: props => createElement('span', { 'data-badge': 'true' }, props.children),
    Codicon: props => createElement('span', { 'data-codicon': props.name }),
    KEYBINDS_AREA: 'keybinds',
    PALETTE_AREA: 'palette',
    PANES_AREA: 'panes',
    STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
    host: {
      state: {
        profile: atom('default'),
        model: atom('openai/gpt-4o'),
        gateway: atom('open'),
        busy: atom(false)
      },
      notify: () => undefined,
      notifyError: () => undefined,
      navigate: () => undefined,
      request: async () => ({ profiles: globalThis.__hermesProfiles ?? [] }),
      openSession: async (id, options) => {
        ;(globalThis.__hermesCalls ??= { openSession: [], newChat: [] }).openSession.push({ id, ...options })
      },
      newChat: profile => {
        ;(globalThis.__hermesCalls ??= { openSession: [], newChat: [] }).newChat.push(profile)
      }
    },
    useQuery: () => ({
      data: globalThis.__hermesRoster,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: async () => undefined
    }),
    useValue: store => store.get()
  }
}

/** Rewrite the bundle's bare imports to the stub, the way the app's import map does. */
function rewriteImports(source) {
  // `react` and `react/jsx-runtime` resolve to the REAL packages (the app's
  // React is the app's React); only the SDK is stubbed.
  return source.replace(/from\s*["']@hermes\/plugin-sdk["']/g, 'from "./hermes-plugin-sdk-stub.mjs"')
}

/** Extract the specifiers the bundle imports. */
function importedSpecifiers(source) {
  const specifiers = new Set()
  const pattern = /(?:from|import)\s*["']([^"']+)["']/g
  let match

  while ((match = pattern.exec(source)) !== null) {
    specifiers.add(match[1])
  }

  return [...specifiers]
}

async function loadPlugin() {
  const source = readFileSync(BUNDLE, 'utf8')
  const stub = makeSdkStub()

  // A tiny module registry: the rewritten bundle asks for these two stubs by
  // name, and we hand them the live objects.
  const stubUrl = 'data:text/javascript;base64,' + Buffer.from('').toString('base64')

  const rewritten = rewriteImports(source)

  // Write the rewritten bundle next to a stub module so Node resolves the
  // bare specifiers. A temp dir keeps the repo clean.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(resolve(tmpdir(), 'hermes-plugin-harness-'))

  writeFileSync(
    resolve(dir, 'hermes-plugin-sdk-stub.mjs'),
    `export const { atom, computed, Badge, Codicon, KEYBINDS_AREA, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, host, useQuery, useValue } = globalThis.__hermesStub
`
  )
  // The bundle imports `react` (the real package) — the temp dir is outside
  // the repo, so node could not resolve it from node_modules. Rewrite it to
  // the absolute path of the installed package.
  const reactPath = fileURLToPath(import.meta.resolve('react'))
  const reactJsxRuntimePath = fileURLToPath(import.meta.resolve('react/jsx-runtime'))

  globalThis.__hermesStub = stub

  const file = resolve(dir, 'plugin.mjs')

  writeFileSync(
    file,
    rewritten
      .replace(/from\s*["']react["']/g, `from ${JSON.stringify(reactPath)}`)
      .replace(/from\s*["']react\/jsx-runtime["']/g, `from ${JSON.stringify(reactJsxRuntimePath)}`)
  )

  const module = await import(file)

  void stubUrl

  return { module, source, stub }
}

/** A recording context, shaped like the app's PluginContext. */
function makeCtx() {
  const contributions = []
  const disposers = []
  const listeners = []
  const calls = { openSession: [], newChat: [], request: [] }
  const scoped = []

  return {
    contributions,
    disposers,
    /** Every listener the plugin installed, so a test can fire it. */
    listeners,
    /** Every host action the plugin took. */
    calls,
    /** Mirrors the SDK's scoped cleanup: removers the context owns. */
    __teardown: () => {
      while (scoped.length > 0) {
        scoped.pop()()
      }

      while (disposers.length > 0) {
        disposers.pop()()
      }
    },
    register: contribution => {
      contributions.push(contribution)

      return () => {
        const index = contributions.indexOf(contribution)

        if (index >= 0) {
          contributions.splice(index, 1)
        }
      }
    },
    registerMany: list => {
      contributions.push(...list)

      return () => {
        for (const item of list) {
          const index = contributions.indexOf(item)

          if (index >= 0) {
            contributions.splice(index, 1)
          }
        }
      }
    },
    registerSettingsPage: () => () => undefined,
    onDispose: fn => disposers.push(fn),
    onEvent: () => () => undefined,
    setTimeout: () => () => undefined,
    setInterval: () => () => undefined,
    addEventListener: (target, type, listener, options) => {
      const entry = { target, type, listener, options }

      listeners.push(entry)

      const remove = () => {
        const index = listeners.indexOf(entry)

        if (index >= 0) {
          listeners.splice(index, 1)
        }
      }

      scoped.push(remove)

      return remove
    },
    os: {
      notify: () => undefined,
      openExternal: async () => false,
      revealPath: async () => false,
      writeClipboard: async () => false
    },
    pet: { say: () => () => undefined, clear: () => undefined, visible: { get: () => false } },
    runAction: () => ({ ok: true }),
    listActions: () => [],
    rest: async () => undefined,
    socket: () => () => undefined,
    storage: {
      get: () => undefined,
      set: () => undefined,
      remove: () => undefined
    }
  }
}

test('the built bundle imports only the three allowed specifiers', async () => {
  const { source } = await loadPlugin()
  const specifiers = importedSpecifiers(source)

  for (const specifier of specifiers) {
    assert.ok(
      ALLOWED_IMPORTS.has(specifier),
      `unexpected import "${specifier}" — the Desktop loader only resolves ${[...ALLOWED_IMPORTS].join(', ')}`
    )
  }
})

test('the bundle loads and default-exports a plugin with the right shape', async () => {
  const { module } = await loadPlugin()
  const plugin = module.default

  assert.ok(plugin, 'the bundle must default-export the plugin')
  assert.equal(typeof plugin.register, 'function')
  assert.equal(plugin.id, 'profile-switcher')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.defaultEnabled, false)
})

test('register() succeeds and contributes the expected surfaces', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  const areas = ctx.contributions.map(contribution => contribution.area)

  assert.ok(areas.includes('panes'), 'the switcher panel must be contributed')
  assert.ok(areas.includes('statusBar.right'), 'the profile chip must be contributed')
  assert.ok(areas.includes('palette'), 'a palette command must be contributed')
  assert.ok(areas.includes('keybinds'), 'a keybind must be contributed')

  const pane = ctx.contributions.find(contribution => contribution.area === 'panes')

  assert.equal(pane.data.placement, 'floating', 'the switcher must float above the app, not tile')

  const keybind = ctx.contributions.find(contribution => contribution.area === 'keybinds')

  assert.equal(keybind.data.id, 'profile-switcher.open')
  assert.equal(keybind.data.category, 'profiles')
  assert.deepEqual(keybind.data.defaults, ['mod+alt+p'])
  assert.equal(typeof keybind.data.run, 'function')
})

test('the contributed keybind does not collide with a core binding', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  // The core combos the plugin's default could have shadowed.
  const coreCombos = new Set([
    'mod+d',
    'mod+shift+]',
    'mod+shift+[',
    'mod+shift+0',
    'mod+alt+1',
    'mod+alt+2',
    'mod+alt+3',
    'mod+alt+4',
    'mod+alt+5',
    'mod+alt+6',
    'mod+alt+7',
    'mod+alt+8',
    'mod+alt+9',
    'mod+alt+t'
  ])

  const keybind = ctx.contributions.find(contribution => contribution.area === 'keybinds')

  for (const combo of keybind.data.defaults) {
    assert.ok(!coreCombos.has(combo), `"${combo}" is a core binding — the switcher would shadow it`)
  }
})

test('every contributed component renders without throwing', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  for (const contribution of ctx.contributions) {
    if (typeof contribution.render !== 'function') {
      continue
    }

    const rendered = contribution.render()

    assert.ok(rendered, `${contribution.id} rendered nothing`)
  }
})

test('the status-bar chip renders the active profile name', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  const chip = ctx.contributions.find(contribution => contribution.area === 'statusBar.right')
  const markup = renderToStaticMarkup(chip.render())

  assert.ok(markup.includes('default'), `the chip must name the active profile, got: ${markup}`)
})

test('the switcher panel renders every profile from the roster', async () => {
  globalThis.__hermesProfiles = [
    { name: 'default', is_default: true, model: 'openai/gpt-4o' },
    { name: 'research', model: 'anthropic/claude-sonnet-4', last_session: { id: 's1', title: 'Paper review' } },
    { name: 'ops', model: 'openai/gpt-4o-mini' }
  ]

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    const panel = ctx.contributions.find(contribution => contribution.area === 'panes')

    // Open the switcher the way the keybind does, then render the panel.
    const keybind = ctx.contributions.find(contribution => contribution.area === 'keybinds')

    keybind.data.run()

    // The roster is fetched on open; let the request settle.
    await new Promise(resolve => setTimeout(resolve, 0))

    const markup = renderToStaticMarkup(panel.render())

    assert.ok(markup.includes('research'), `the panel must list the research profile, got: ${markup}`)
    assert.ok(markup.includes('Paper review'), `the panel must show the last session title, got: ${markup}`)
    assert.ok(markup.includes('anthropic/claude-sonnet-4'), `the panel must show the model, got: ${markup}`)
    assert.ok(markup.includes('ops'), `the panel must list every profile, got: ${markup}`)
  } finally {
    globalThis.__hermesProfiles = undefined
  }
})

test('the palette command opens the switcher without throwing', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  const palette = ctx.contributions.find(contribution => contribution.area === 'palette')

  assert.equal(typeof palette.data.run, 'function')
  palette.data.run()
})

test('the keybind handler runs without throwing', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  const keybind = ctx.contributions.find(contribution => contribution.area === 'keybinds')

  keybind.data.run()
})

test('dispose tears the plugin down', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  assert.ok(ctx.disposers.length > 0, 'the plugin must register a disposer')

  for (const dispose of ctx.disposers) {
    dispose()
  }
})

/** Fire the plugin's own listener for `type`, the way the DOM would. */
function fire(ctx, type, props) {
  const event = {
    altKey: false,
    code: '',
    ctrlKey: false,
    defaultPrevented: false,
    key: '',
    repeat: false,
    shiftKey: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.stopped = true
    }
  }

  Object.assign(event, props)

  for (const entry of ctx.listeners.filter(listener => listener.type === type)) {
    entry.listener(event)
  }

  return event
}

/** Is the panel currently rendering anything? */
function panelOpen(ctx) {
  const panel = ctx.contributions.find(contribution => contribution.area === 'panes')

  return renderToStaticMarkup(panel.render()).length > 0
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const ROSTER = [
  {
    name: 'default',
    is_default: true,
    model: 'openai/gpt-4o',
    last_session: { id: 's0', title: 'Kickoff' }
  },
  { name: 'research', model: 'anthropic/claude-sonnet-4', last_session: { id: 's1', title: 'Paper review' } },
  { name: 'ops', model: 'openai/gpt-4o-mini' }
]

test('the gesture installs its own keydown and keyup listeners', async () => {
  const { module } = await loadPlugin()
  const ctx = makeCtx()

  module.default.register(ctx)

  const types = ctx.listeners.map(entry => entry.type).sort()

  assert.deepEqual(types, ['keydown', 'keyup'])
})

test('Alt+Tab alone is NOT intercepted — the OS owns that chord', async () => {
  globalThis.__hermesProfiles = ROSTER

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    // A plain Alt+Tab: Ctrl is not held. The renderer never sees this in a
    // real OS, but if it did, the plugin must still not claim it.
    const event = fire(ctx, 'keydown', { altKey: true, code: 'Tab', key: 'Tab' })

    assert.equal(panelOpen(ctx), false, 'Alt+Tab must not open the switcher')
    assert.equal(event.defaultPrevented, false, 'Alt+Tab must not be swallowed')
    assert.equal(event.stopped, false, 'Alt+Tab must not be stopped')
  } finally {
    globalThis.__hermesProfiles = undefined
  }
})

test('hold Ctrl+Alt and tap Tab opens the panel on the NEXT profile', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    const event = fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab' })

    assert.equal(event.defaultPrevented, true, 'the gesture must claim the chord')
    assert.equal(panelOpen(ctx), true, 'the gesture must open the panel')

    // The active profile is `default`; the first tap must move to `research`.
    await settle()

    const markup = renderToStaticMarkup(
      ctx.contributions.find(contribution => contribution.area === 'panes').render()
    )

    const researchRow = markup.split('<button').find(chunk => chunk.includes('research'))

    assert.ok(researchRow.includes('data-selected="true"'), 'the first tap must move OFF the active profile')
  } finally {
    globalThis.__hermesProfiles = undefined
  }
})

test('releasing Ctrl lands on the highlighted profile', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab' })
    await settle()

    fire(ctx, 'keyup', { altKey: true, key: 'Control' })
    await settle()

    assert.equal(globalThis.__hermesCalls.openSession.length, 1, 'release must switch once')
    assert.equal(globalThis.__hermesCalls.openSession[0].profile, 'research')
    assert.equal(globalThis.__hermesCalls.openSession[0].keepAllProfilesScope, false)
    assert.equal(globalThis.__hermesCalls.openSession[0].id, 's1', 'must resume that profile last session')
    assert.equal(panelOpen(ctx), false, 'the panel must close after landing')
  } finally {
    globalThis.__hermesProfiles = undefined
    globalThis.__hermesCalls = undefined
  }
})

test('each extra tap advances exactly one row, wrapping around', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    // default (active) -> research -> ops -> wraps to default.
    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab' })
    await settle()
    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab', repeat: false })
    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab', repeat: false })

    fire(ctx, 'keyup', { altKey: true, key: 'Control' })
    await settle()

    assert.equal(globalThis.__hermesCalls.openSession.length, 1)
    assert.equal(
      globalThis.__hermesCalls.openSession[0].profile,
      'default',
      'three taps from the active profile must wrap back to it'
    )
  } finally {
    globalThis.__hermesProfiles = undefined
    globalThis.__hermesCalls = undefined
  }
})

test('auto-repeat does not race through the list', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab' })
    await settle()

    // Holding Tab fires keydown repeatedly with repeat=true; only the first
    // physical press counts, so the highlight stays on `research`.
    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab', repeat: true })
    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab', repeat: true })

    fire(ctx, 'keyup', { altKey: true, key: 'Control' })
    await settle()

    assert.equal(globalThis.__hermesCalls.openSession[0].profile, 'research')
  } finally {
    globalThis.__hermesProfiles = undefined
    globalThis.__hermesCalls = undefined
  }
})

test('releasing the modifier does NOT commit a panel opened with Ctrl+Alt+P', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    ctx.contributions.find(contribution => contribution.area === 'keybinds').data.run()
    await settle()

    assert.equal(panelOpen(ctx), true, 'the keybind must open the panel')

    fire(ctx, 'keyup', { key: 'Control' })
    await settle()

    assert.equal(globalThis.__hermesCalls.openSession.length, 0, 'a deliberate open must wait for Enter or a click')
    assert.equal(panelOpen(ctx), true, 'the panel must stay open')

    fire(ctx, 'keydown', { key: 'Enter' })
    await settle()

    assert.equal(globalThis.__hermesCalls.openSession.length, 1, 'Enter must commit')
    assert.equal(globalThis.__hermesCalls.openSession[0].profile, 'default', 'it starts on the active profile')
  } finally {
    globalThis.__hermesProfiles = undefined
    globalThis.__hermesCalls = undefined
  }
})

test('Escape closes without switching, and teardown removes the listeners', async () => {
  globalThis.__hermesProfiles = ROSTER
  globalThis.__hermesCalls = { openSession: [], newChat: [] }

  try {
    const { module } = await loadPlugin()
    const ctx = makeCtx()

    module.default.register(ctx)

    fire(ctx, 'keydown', { altKey: true, code: 'Tab', ctrlKey: true, key: 'Tab' })
    await settle()

    fire(ctx, 'keydown', { key: 'Escape' })
    await settle()

    assert.equal(panelOpen(ctx), false, 'Escape must close the panel')
    assert.equal(globalThis.__hermesCalls.openSession.length, 0, 'Escape must not switch')

    ctx.__teardown()

    assert.equal(ctx.listeners.length, 0, 'teardown must leave no keyboard hooks behind')
  } finally {
    globalThis.__hermesProfiles = undefined
    globalThis.__hermesCalls = undefined
  }
})
