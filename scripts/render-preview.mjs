/**
 * Render the switcher panel to a standalone HTML file.
 *
 * The Electron app cannot run on a headless host, so this renders the REAL
 * component (the built bundle, through the same stub SDK the harness uses)
 * to markup, wrapped in a page that carries the app's own theme variables.
 *
 * The result is a faithful picture of the switcher's own UI — the app's
 * surrounding chrome is not reproduced, and the file says so.
 *
 * Usage: node scripts/render-preview.mjs [out.html]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BUNDLE = resolve(ROOT, 'profile-switcher', 'desktop', 'plugin.js')
const OUT = resolve(process.argv[2] ?? resolve(ROOT, 'assets', 'preview.html'))

/** The roster the preview shows — a realistic multi-profile setup. */
const ROSTER = [
  {
    name: 'default',
    is_default: true,
    model: 'anthropic/claude-sonnet-4-6',
    skill_count: 92,
    last_session: { id: 's1', title: 'Refactor the gateway connection pool', last_active: Date.now() - 4 * 60_000 }
  },
  {
    name: 'research',
    model: 'anthropic/claude-sonnet-4-6',
    last_session: { id: 's2', title: 'Paper review: speculative decoding', last_active: Date.now() - 52 * 60_000 }
  },
  {
    name: 'ops',
    model: 'openai/gpt-5.6-terra',
    last_session: { id: 's3', title: 'Disk pressure on the build host', last_active: Date.now() - 3 * 3600_000 },
    worker_session: { id: 'w1', title: 'nightly-index' }
  },
  {
    name: 'colons-dev',
    model: 'openai/gpt-5.6-sol',
    last_session: { id: 's4', title: 'Add the profile switcher to the app', last_active: Date.now() - 26 * 3600_000 }
  },
  {
    name: 'writing',
    display_name: 'Long-form writing',
    model: 'anthropic/claude-sonnet-4-6',
    last_session: { id: 's5', title: 'Draft: the Q3 platform post', last_active: Date.now() - 9 * 86400_000 }
  }
]

/** A stub of the SDK, matching the harness. */
function makeSdkStub() {
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
    atom,
    Badge: props => createElement('span', { className: 'badge' }, props.children),
    Codicon: props => createElement('span', { className: 'codicon', title: props.name }, '◆'),
    KEYBINDS_AREA: 'keybinds',
    PALETTE_AREA: 'palette',
    PANES_AREA: 'panes',
    STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
    host: {
      state: { profile: atom('default'), model: atom('anthropic/claude-sonnet-4-6'), gateway: atom('open'), busy: atom(false) },
      notify: () => undefined,
      notifyError: () => undefined,
      navigate: () => undefined,
      request: async () => ({ profiles: ROSTER }),
      openSession: async () => undefined,
      newChat: () => undefined
    },
    useQuery: () => ({ data: ROSTER, isLoading: false, isFetching: false, error: null, refetch: async () => undefined }),
    useValue: store => store.get()
  }
}

async function loadPlugin() {
  const source = readFileSync(BUNDLE, 'utf8')
  const stub = makeSdkStub()

  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(resolve(tmpdir(), 'hermes-plugin-preview-'))

  writeFileSync(
    resolve(dir, 'hermes-plugin-sdk-stub.mjs'),
    `export const { atom, Badge, Codicon, KEYBINDS_AREA, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, host, useQuery, useValue } = globalThis.__hermesStub
`
  )

  const reactPath = fileURLToPath(import.meta.resolve('react'))
  const reactJsxRuntimePath = fileURLToPath(import.meta.resolve('react/jsx-runtime'))

  globalThis.__hermesStub = stub

  const file = resolve(dir, 'plugin.mjs')

  writeFileSync(
    file,
    source
      .replace(/from\s*["']@hermes\/plugin-sdk["']/g, 'from "./hermes-plugin-sdk-stub.mjs"')
      .replace(/from\s*["']react["']/g, `from ${JSON.stringify(reactPath)}`)
      .replace(/from\s*["']react\/jsx-runtime["']/g, `from ${JSON.stringify(reactJsxRuntimePath)}`)
  )

  return import(file)
}

const module = await loadPlugin()
const ctx = {
  registerMany: list => {
    ctx.contributions = list
  },
  register: () => () => undefined,
  registerSettingsPage: () => () => undefined,
  onDispose: () => undefined,
  storage: { get: (_key, fallback) => fallback, set: () => undefined, remove: () => undefined }
}

module.default.register(ctx)

const panel = ctx.contributions.find(contribution => contribution.area === 'panes')
const keybind = ctx.contributions.find(contribution => contribution.area === 'keybinds')

// Open the switcher the way the keybind does.
keybind.data.run()

const markup = renderToStaticMarkup(panel.render())

/**
 * The app's own theme variables, so the preview uses the real palette
 * instead of invented colours. A dark-mode subset of the app's tokens.
 */
const THEME = `
  :root {
    --ui-text-primary: #e8eaf0;
    --ui-text-secondary: #c3c8d4;
    --ui-text-quaternary: #8b91a3;
    --ui-text-tertiary: #6b7185;
    --ui-accent: #4a84fe;
    --ui-accent-foreground: #ffffff;
    --ui-hover-surface: rgba(255, 255, 255, 0.05);
    --ui-stroke-secondary: rgba(255, 255, 255, 0.10);
    --ui-chat-bubble-background: #1c1f27;
    --stroke-nous: rgba(255, 255, 255, 0.12);
    --theme-primary: #4a84fe;
  }
`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Profile Switcher — preview</title>
<!-- Tailwind's browser build, so the preview renders the plugin's real
     utility classes the way the Desktop app's compiled stylesheet does. -->
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style>
${THEME}
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #12141a;
    color: var(--ui-text-primary);
    font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 28px; }
  .caption {
    margin: 0 0 14px;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--theme-primary);
  }
  .shadow-nous { box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); }
  .badge {
    display: inline-flex; align-items: center; border-radius: 3px; font-weight: 500;
    background: rgba(255, 255, 255, 0.08); color: var(--ui-text-secondary);
    padding: 1px 5px; font-size: 10px;
  }
  .codicon { color: var(--ui-text-tertiary); font-size: 10px; }

  /* The panel renders as a full-screen overlay in the app. For the preview
     page, flatten it to the card alone so the capture is the switcher and
     nothing else. */
  .frame > div.fixed {
    position: static !important;
    display: block !important;
    padding: 0 !important;
  }
  .frame > div.fixed > div.absolute { display: none !important; }
</style>
</head>
<body>
  <div class="frame">
    <p class="caption">Profile Switcher</p>
    ${markup}
  </div>
</body>
</html>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)

console.log(`wrote ${OUT}`)
