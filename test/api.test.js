// End-to-end API test: boots a real server against a throwaway storage directory and
// drives it the way the website and the Forge desktop app do.
//
//   node test/api.test.js

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storage = mkdtempSync(join(tmpdir(), 'forge-store-test-'))
const PORT = 4899
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok  ${label}`)
  } else {
    failures.push(`${label}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

// A minimal but structurally valid .glb: a 12-byte header plus one JSON chunk.
function fakeGlb(extraBytes = 0) {
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }) + ' '.repeat(extraBytes)
  const padded = jsonText + ' '.repeat((4 - (Buffer.byteLength(jsonText) % 4)) % 4)
  const jsonBuf = Buffer.from(padded, 'utf-8')
  const glb = Buffer.alloc(12 + 8 + jsonBuf.length)
  glb.write('glTF', 0, 'ascii')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jsonBuf.length, 12)
  glb.write('JSON', 16, 'ascii')
  jsonBuf.copy(glb, 20)
  return glb
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let cookie = ''

async function call(path, { method = 'GET', body, headers = {}, useCookie = true, key = null } = {}) {
  const isBuffer = Buffer.isBuffer(body)
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(isBuffer || body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(useCookie && cookie ? { cookie } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers
    },
    body: isBuffer ? body : body === undefined ? undefined : JSON.stringify(body)
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie && useCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, res }
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const until = Date.now() + 15000
    const poll = async () => {
      try {
        const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) })
        if (r.ok) return resolve()
      } catch {
        /* not yet */
      }
      if (Date.now() > until) return reject(new Error('server never came up'))
      setTimeout(poll, 200)
    }
    poll()
  })
}

const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', FORGE_STORE_STORAGE: storage },
  stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

async function run() {
  await waitForServer()

  // --- accounts ---
  check('health responds', (await call('/api/health')).json?.ok === true)
  check('anonymous /api/me is 401', (await call('/api/me')).status === 401)

  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'Tester', password: 'longenough1' }
  })
  check('register succeeds', reg.status === 201, reg.text)
  check('register signs you in', (await call('/api/me')).json?.user?.username === 'Tester')

  const dupe = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'tester', password: 'longenough1' },
    useCookie: false
  })
  check('duplicate username refused', dupe.status === 409, dupe.text)

  const shortPw = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'other', password: 'short' },
    useCookie: false
  })
  check('short password refused', shortPw.status === 400)

  const badLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'wrongwrong' }, useCookie: false })
  check('wrong password refused', badLogin.status === 401)

  // --- api key (what the desktop app uses) ---
  const keyRes = await call('/api/keys', { method: 'POST', body: { label: 'test key' } })
  const apiKey = keyRes.json?.key
  check('api key issued', typeof apiKey === 'string' && apiKey.startsWith('fvs_'), keyRes.text)
  check('api key authenticates', (await call('/api/me', { useCookie: false, key: apiKey })).json?.user?.displayName === 'Tester')
  check('bogus api key rejected', (await call('/api/me', { useCookie: false, key: 'fvs_nope' })).status === 401)

  // --- packs ---
  const created = await call('/api/packs', { method: 'POST', body: { name: 'Derelict Station Kit', section: 'props', description: 'test pack' } })
  const pack = created.json?.pack
  check('pack created', created.status === 201 && pack?.slug === 'derelict-station-kit', created.text)

  const clash = await call('/api/packs', { method: 'POST', body: { name: '  derelict station KIT ', section: 'props' } })
  check('same-name pack refused (409)', clash.status === 409, clash.text)

  const second = await call('/api/packs', { method: 'POST', body: { name: 'Character Test', section: 'characters' } })
  check('second pack in another section', second.status === 201 && second.json.pack.section === 'characters')

  // --- uploads ---
  const upload = await call(`/api/packs/${pack.id}/assets`, {
    method: 'POST',
    body: fakeGlb(),
    useCookie: false,
    key: apiKey,
    headers: {
      'content-type': 'model/gltf-binary',
      'x-asset-name': encodeURIComponent('crate small'),
      'x-asset-filename': 'crate-small.glb',
      'x-asset-triangles': '412',
      'x-asset-source-id': 'crate-small-abc123'
    }
  })
  check('asset uploaded with an api key', upload.status === 201, upload.text)
  const assetId = upload.json?.asset?.id

  const thumb = await call(`/api/packs/${pack.id}/assets/${assetId}/thumb`, {
    method: 'POST',
    body: PNG,
    useCookie: false,
    key: apiKey,
    headers: { 'content-type': 'image/png' }
  })
  check('thumbnail accepted', thumb.status === 200 && !!thumb.json?.asset?.thumbUrl, thumb.text)

  const notGlb = await call(`/api/packs/${pack.id}/assets`, {
    method: 'POST',
    body: Buffer.from('this is definitely not a glb file'),
    useCookie: false,
    key: apiKey,
    headers: { 'content-type': 'model/gltf-binary', 'x-asset-name': 'bogus' }
  })
  check('non-glb upload refused', notGlb.status === 400, notGlb.text)

  const notPng = await call(`/api/packs/${pack.id}/assets/${assetId}/thumb`, {
    method: 'POST',
    body: Buffer.from('nope'),
    useCookie: false,
    key: apiKey,
    headers: { 'content-type': 'image/png' }
  })
  check('non-png preview refused', notPng.status === 400)

  // Re-publishing the same source asset replaces rather than duplicates.
  const again = await call(`/api/packs/${pack.id}/assets`, {
    method: 'POST',
    body: fakeGlb(40),
    useCookie: false,
    key: apiKey,
    headers: {
      'content-type': 'model/gltf-binary',
      'x-asset-name': encodeURIComponent('crate small'),
      'x-asset-source-id': 'crate-small-abc123'
    }
  })
  check('re-publishing replaces in place', again.json?.asset?.id === assetId, again.text)
  check('pack still holds one asset', (await call(`/api/packs/${pack.id}`)).json?.pack?.assetCount === 1)

  // A second asset, for cover and download coverage.
  const upload2 = await call(`/api/packs/${pack.id}/assets`, {
    method: 'POST',
    body: fakeGlb(8),
    useCookie: false,
    key: apiKey,
    headers: { 'content-type': 'model/gltf-binary', 'x-asset-name': encodeURIComponent('barrel'), 'x-asset-source-id': 'barrel-xyz' }
  })
  const asset2 = upload2.json?.asset?.id
  check('second asset uploaded', upload2.status === 201)

  // --- ownership ---
  const strangerCookie = cookie
  cookie = ''
  await call('/api/auth/register', { method: 'POST', body: { username: 'intruder', password: 'longenough2' } })
  const intruderPatch = await call(`/api/packs/${pack.id}`, { method: 'PATCH', body: { name: 'Stolen' } })
  check("another user cannot edit someone else's pack", intruderPatch.status === 403, intruderPatch.text)
  const intruderDelete = await call(`/api/packs/${pack.id}`, { method: 'DELETE' })
  check('another user cannot delete it either', intruderDelete.status === 403)
  cookie = strangerCookie

  // --- covers and browsing ---
  const covers = await call(`/api/packs/${pack.id}`, { method: 'PATCH', body: { coverAssetIds: [asset2, 'not-a-real-id'] } })
  check('cover list keeps only real assets', JSON.stringify(covers.json?.pack?.coverAssetIds) === JSON.stringify([asset2]), covers.text)

  const listing = await call('/api/packs?section=props')
  check('props section lists the pack', listing.json?.packs?.some((p) => p.id === pack.id))
  check('counts include both sections', listing.json?.counts?.characters === 1 && listing.json?.counts?.props === 1)
  const search = await call('/api/packs?q=barrel')
  check('search finds packs by asset name', search.json?.packs?.some((p) => p.id === pack.id), search.text)
  const emptySearch = await call('/api/packs?q=zzzznothing')
  check('search misses cleanly', emptySearch.json?.packs?.length === 0)

  // --- files and download ---
  const file = await fetch(`${BASE}/files/assets/${assetId}.glb`)
  const fileBuf = Buffer.from(await file.arrayBuffer())
  check('asset file downloads', file.ok && fileBuf.toString('ascii', 0, 4) === 'glTF')
  const zip = await fetch(`${BASE}/api/packs/${pack.id}/download`)
  const zipBuf = Buffer.from(await zip.arrayBuffer())
  check('pack zip downloads', zip.ok && zipBuf.toString('ascii', 0, 2) === 'PK', `status ${zip.status}`)
  check('zip carries both assets and the manifest', zipBuf.toString('latin1').split('derelict-station-kit/').length - 1 >= 3)

  // --- removal ---
  const removed = await call(`/api/packs/${pack.id}/assets/${asset2}`, { method: 'DELETE' })
  check('asset removed', removed.status === 204)
  const afterRemoval = await call(`/api/packs/${pack.id}`)
  check('pack shrinks and re-covers itself', afterRemoval.json?.pack?.assetCount === 1 && afterRemoval.json?.pack?.coverAssetIds?.[0] === assetId)

  const del = await call(`/api/packs/${pack.id}`, { method: 'DELETE' })
  check('pack deleted', del.status === 204)
  check('deleted pack is gone', (await call(`/api/packs/${pack.id}`)).status === 404)
  check('its files are gone too', (await fetch(`${BASE}/files/assets/${assetId}.glb`)).status === 404)

  // --- static site ---
  check('catalogue page serves', (await fetch(`${BASE}/`)).ok)
  const missing = await fetch(`${BASE}/nope.html`, { headers: { accept: 'text/html' } })
  check('missing page returns the 404 page', missing.status === 404 && (await missing.text()).includes('No page under that number'))
  check('path traversal refused', (await fetch(`${BASE}/files/assets/..%2F..%2Fdb.json`)).status >= 400)
}

run()
  .catch((e) => {
    failures.push('threw: ' + e.message)
    console.error(e)
  })
  .finally(() => {
    server.kill()
    setTimeout(() => {
      try {
        rmSync(storage, { recursive: true, force: true })
      } catch {
        /* windows may still hold a handle; the temp dir is disposable anyway */
      }
      console.log(`\n${passed} passed, ${failures.length} failed`)
      if (failures.length) {
        for (const f of failures) console.log('  ✕ ' + f)
        process.exit(1)
      }
      process.exit(0)
    }, 300)
  })
