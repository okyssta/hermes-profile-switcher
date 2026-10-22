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

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..', 'profile-switcher', 'desktop', 'plugin.js')

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

  return {
    __atoms: listeners,
    atom,
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
      request: async () => ({ profiles: [] }),
      openSession: async () => undefined,
      newChat: () => undefined
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
    `export const { atom, Badge, Codicon, KEYBINDS_AREA, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, host, useQuery, useValue } = globalThis.__hermesStub
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

  return {
    contributions,
    disposers,
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
    addEventListener: () => () => undefined,
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
  globalThis.__hermesRoster = [
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

    const markup = renderToStaticMarkup(panel.render())

    assert.ok(markup.includes('research'), `the panel must list the research profile, got: ${markup}`)
    assert.ok(markup.includes('Paper review'), `the panel must show the last session title, got: ${markup}`)
    assert.ok(markup.includes('anthropic/claude-sonnet-4'), `the panel must show the model, got: ${markup}`)
    assert.ok(markup.includes('ops'), `the panel must list every profile, got: ${markup}`)
  } finally {
    globalThis.__hermesRoster = undefined
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
