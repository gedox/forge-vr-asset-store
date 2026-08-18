#!/usr/bin/env node
// "sforge" — start the Forge VR Asset Store and open it in the browser.
//
// Run it from anywhere. If a store server is already listening on the port it just opens
// the tab; otherwise it starts one here and hands the terminal to it, so Ctrl+C stops the
// store the way you would expect.
//
// Usage:
//   sforge                 start (if needed) and open the catalogue
//   sforge --no-open       start without opening a browser
//   sforge --port 5000     use another port
//   sforge profile         open a specific page (profile | catalogue | <path>)

// The package is ESM ("type": "module"), so this launcher is too.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
const args = process.argv.slice(2)

function flag(name) {
  const i = args.indexOf(name)
  if (i < 0) return null
  const value = args[i + 1]
  args.splice(i, value && !value.startsWith('-') ? 2 : 1)
  return value ?? true
}

const noOpen = !!flag('--no-open')
const port = Number(flag('--port') || process.env.PORT || 4173)
const page = (args[0] || '').replace(/^\/+/, '')
const PAGES = { profile: 'profile.html', packs: 'profile.html', catalogue: 'index.html', catalog: 'index.html' }
const target = `http://localhost:${port}/${PAGES[page] ?? page}`

function openBrowser(url) {
  if (noOpen) {
    console.log(`[sforge] ${url}`)
    return
  }
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]]
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref()
  console.log(`[sforge] opened ${url}`)
}

async function isUp() {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1200) })
    return res.ok
  } catch {
    return false
  }
}

async function waitUntilUp(deadlineMs = 15000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (await isUp()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function main() {
  if (await isUp()) {
    console.log(`[sforge] store already running on port ${port}`)
    openBrowser(target)
    return
  }

  console.log(`[sforge] starting the store from ${root}…`)
  const child = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) }
  })
  child.on('error', (e) => {
    console.error('[sforge] could not start the server:', e.message)
    process.exit(1)
  })
  child.on('close', (code) => process.exit(code ?? 0))

  if (!(await waitUntilUp())) {
    console.error('[sforge] the server did not come up — see the output above.')
    return
  }
  openBrowser(target)
}

main().catch((e) => {
  console.error('[sforge]', e.message)
  process.exit(1)
})
