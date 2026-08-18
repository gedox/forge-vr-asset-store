// The Forge VR Asset Store server.
//
// One node:http server with three jobs: a JSON API (used by both the website and the Forge
// desktop app), the uploaded files, and the static site itself. No framework — the routing
// table below is the whole of it.

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  ASSETS_DIR,
  GOOGLE_ENABLED,
  HOST,
  MAX_ASSETS_PER_PACK,
  MAX_ASSET_BYTES,
  MAX_COVER_ASSETS,
  MAX_JSON_BYTES,
  MAX_PACK_BYTES,
  MAX_THUMB_BYTES,
  PORT,
  PUBLIC_DIR,
  ROOT,
  SECTIONS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SITE_NAME,
  THUMBS_DIR
} from './config.js'
import { db, flush } from './db.js'
import {
  createApiKey,
  createSession,
  currentUser,
  deleteApiKey,
  destroySession,
  googleAuthUrl,
  googleExchange,
  listApiKeys,
  loginUser,
  publicUser,
  registerUser,
  requireUser,
  upsertGoogleUser
} from './auth.js'
import {
  addAsset,
  assetsOf,
  createPack,
  deletePack,
  findPack,
  ownedPack,
  packsOf,
  publicAsset,
  publicPack,
  removeAsset,
  setAssetThumb,
  updatePack
} from './packs.js'
import { buildZip } from './zip.js'
import {
  HttpError,
  badRequest,
  clearCookie,
  json,
  match,
  headerText,
  noContent,
  notFound,
  parseCookies,
  readBody,
  readJson,
  redirect,
  sendFile,
  setCookie
} from './http.js'

const OAUTH_STATE_COOKIE = 'forge_store_oauth'

// --- route table -------------------------------------------------------------
// Each entry is [method, pattern, handler]. Handlers receive ({ req, res, params, url })
// and may throw HttpError; anything else becomes a 500.
const routes = [
  ['GET', '/api/health', ({ res }) => json(res, 200, { ok: true, name: SITE_NAME })],

  ['GET', '/api/config', ({ res }) =>
    json(res, 200, {
      name: SITE_NAME,
      googleEnabled: GOOGLE_ENABLED,
      sections: SECTIONS,
      limits: {
        maxAssetBytes: MAX_ASSET_BYTES,
        maxPackBytes: MAX_PACK_BYTES,
        maxAssetsPerPack: MAX_ASSETS_PER_PACK,
        maxCoverAssets: MAX_COVER_ASSETS
      }
    })],

  // --- auth ---
  ['POST', '/api/auth/register', async ({ req, res }) => {
    const body = await readJson(req, MAX_JSON_BYTES)
    const user = registerUser(body)
    startSession(res, user)
    json(res, 201, { user: publicUser(user) })
  }],

  ['POST', '/api/auth/login', async ({ req, res }) => {
    const body = await readJson(req, MAX_JSON_BYTES)
    const user = loginUser(body)
    startSession(res, user)
    json(res, 200, { user: publicUser(user) })
  }],

  ['POST', '/api/auth/logout', ({ req, res }) => {
    const sid = parseCookies(req)[SESSION_COOKIE]
    if (sid) destroySession(sid)
    clearCookie(res, SESSION_COOKIE)
    noContent(res)
  }],

  ['GET', '/api/me', ({ req, res }) => {
    const user = requireUser(req)
    json(res, 200, { user: publicUser(user) })
  }],

  ['GET', '/auth/google', ({ res }) => {
    if (!GOOGLE_ENABLED) {
      throw badRequest('Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
    }
    const state = randomBytes(16).toString('hex')
    setCookie(res, OAUTH_STATE_COOKIE, state, { maxAge: 10 * 60 * 1000 })
    redirect(res, googleAuthUrl(state))
  }],

  ['GET', '/auth/google/callback', async ({ req, res, url }) => {
    const state = url.searchParams.get('state')
    const expected = parseCookies(req)[OAUTH_STATE_COOKIE]
    // Without this check a third-party page could complete a sign-in on the visitor's
    // behalf; the state must be the one this browser was issued.
    if (!state || !expected || state !== expected) {
      throw badRequest('The sign-in did not come back the way it left. Try again.')
    }
    clearCookie(res, OAUTH_STATE_COOKIE)
    const code = url.searchParams.get('code')
    if (!code) throw badRequest(url.searchParams.get('error') || 'Google returned no authorisation code.')
    const info = await googleExchange(code)
    const user = upsertGoogleUser(info)
    startSession(res, user)
    redirect(res, '/profile.html')
  }],

  // --- API keys ---
  ['GET', '/api/keys', ({ req, res }) => json(res, 200, { keys: listApiKeys(requireUser(req).id) })],

  ['POST', '/api/keys', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readJson(req, MAX_JSON_BYTES)
    const { record, key } = createApiKey(user.id, body.label)
    // The only time the plain key exists outside the client's hands.
    json(res, 201, { key, record: { id: record.id, label: record.label, hint: record.hint, createdAt: record.createdAt } })
  }],

  ['DELETE', '/api/keys/:id', ({ req, res, params }) => {
    const user = requireUser(req)
    if (!deleteApiKey(user.id, params.id)) throw notFound('No such key.')
    noContent(res)
  }],

  // --- browsing ---
  ['GET', '/api/packs', ({ res, url }) => {
    const section = url.searchParams.get('section') || 'all'
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const sort = url.searchParams.get('sort') || 'newest'
    let list = db().packs.slice()
    if (SECTIONS.includes(section)) list = list.filter((p) => p.section === section)
    if (q) {
      list = list.filter((p) => {
        const haystack = [p.name, p.description, ...assetsOf(p.id).map((a) => a.name)].join(' ').toLowerCase()
        return haystack.includes(q)
      })
    }
    const shaped = list.map((p) => publicPack(p, { withAssets: true }))
    shaped.sort((a, b) => {
      if (sort === 'largest') return b.assetCount - a.assetCount
      if (sort === 'name') return a.name.localeCompare(b.name)
      return new Date(b.updatedAt) - new Date(a.updatedAt)
    })
    json(res, 200, {
      packs: shaped,
      counts: {
        all: db().packs.length,
        ...Object.fromEntries(SECTIONS.map((s) => [s, db().packs.filter((p) => p.section === s).length]))
      }
    })
  }],

  ['GET', '/api/me/packs', ({ req, res }) => {
    const user = requireUser(req)
    const packs = packsOf(user.id)
      .map((p) => publicPack(p))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    json(res, 200, { packs })
  }],

  ['POST', '/api/packs', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readJson(req, MAX_JSON_BYTES)
    json(res, 201, { pack: publicPack(createPack(user, body)) })
  }],

  ['GET', '/api/packs/:id', ({ res, params }) => {
    const pack = findPack(params.id)
    if (!pack) throw notFound('No such pack.')
    json(res, 200, { pack: publicPack(pack) })
  }],

  ['PATCH', '/api/packs/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const body = await readJson(req, MAX_JSON_BYTES)
    json(res, 200, { pack: publicPack(updatePack(user, params.id, body)) })
  }],

  ['DELETE', '/api/packs/:id', ({ req, res, params }) => {
    deletePack(requireUser(req), params.id)
    noContent(res)
  }],

  // Raw upload: the .glb is the entire body, its metadata rides in headers. This is what
  // both the desktop app and the website's own uploader use.
  ['POST', '/api/packs/:id/assets', async ({ req, res, params }) => {
    const user = requireUser(req)
    const buffer = await readBody(req, MAX_ASSET_BYTES)
    const asset = addAsset(user, params.id, buffer, {
      name: headerText(req, 'x-asset-name'),
      fileName: headerText(req, 'x-asset-filename'),
      category: headerText(req, 'x-asset-category', 'prop'),
      triangles: headerText(req, 'x-asset-triangles', '0'),
      sourceId: headerText(req, 'x-asset-source-id')
    })
    json(res, 201, { asset: publicAsset(asset) })
  }],

  ['POST', '/api/packs/:id/assets/:assetId/thumb', async ({ req, res, params }) => {
    const user = requireUser(req)
    const buffer = await readBody(req, MAX_THUMB_BYTES)
    const asset = setAssetThumb(user, params.id, params.assetId, buffer)
    json(res, 200, { asset: publicAsset(asset) })
  }],

  ['DELETE', '/api/packs/:id/assets/:assetId', ({ req, res, params }) => {
    removeAsset(requireUser(req), params.id, params.assetId)
    noContent(res)
  }],

  // --- files ---
  ['GET', '/api/packs/:id/download', ({ res, params }) => {
    const pack = findPack(params.id)
    if (!pack) throw notFound('No such pack.')
    const assets = assetsOf(pack.id)
    if (!assets.length) throw notFound('That pack has no assets yet.')
    const seen = new Map()
    const entries = assets.map((asset) => {
      // Two assets in a pack can legitimately share a file name; keep both.
      const count = (seen.get(asset.fileName) ?? 0) + 1
      seen.set(asset.fileName, count)
      const name = count === 1 ? asset.fileName : asset.fileName.replace(/(\.glb)?$/i, `-${count}$1`)
      return { name: `${pack.slug}/${name}`, data: readFileSync(join(ASSETS_DIR, asset.id + '.glb')), date: new Date(asset.createdAt) }
    })
    entries.push({
      name: `${pack.slug}/pack.json`,
      data: Buffer.from(JSON.stringify(publicPack(pack), null, 2), 'utf-8')
    })
    const zip = buildZip(entries)
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      'content-disposition': `attachment; filename="${pack.slug}.zip"`
    })
    res.end(zip)
  }],

  ['GET', '/files/assets/:file', ({ res, params }) => {
    const asset = db().assets.find((a) => a.id + '.glb' === params.file)
    sendFile(res, ASSETS_DIR, params.file, { download: asset?.fileName || params.file })
  }],

  ['GET', '/files/thumbs/:file', ({ res, params }) => sendFile(res, THUMBS_DIR, params.file, { immutable: true })]
]

function startSession(res, user) {
  const session = createSession(user.id)
  setCookie(res, SESSION_COOKIE, session.id, { maxAge: SESSION_TTL_MS })
}

// --- static site -------------------------------------------------------------
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  // Pretty URLs: /packs → /packs.html when that page exists.
  if (!rel.includes('.') && existsSync(join(PUBLIC_DIR, rel + '.html'))) rel += '.html'
  // three.js is served straight out of node_modules so the repository carries no vendored
  // copy of a library that npm already knows how to fetch.
  if (rel.startsWith('/vendor/three/')) {
    return sendFile(res, join(ROOT, 'node_modules', 'three'), rel.slice('/vendor/three/'.length), { immutable: true })
  }
  const full = join(PUBLIC_DIR, rel)
  if (!existsSync(full)) throw notFound('No such page.')
  sendFile(res, PUBLIC_DIR, rel, { immutable: rel.startsWith('/fonts/') })
}

// --- server ------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue
      const params = match(pattern, url.pathname)
      if (!params) continue
      await handler({ req, res, params, url })
      return
    }
    if (req.method === 'GET') {
      serveStatic(req, res, url.pathname)
      return
    }
    throw notFound(`No route for ${req.method} ${url.pathname}`)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status >= 500) console.error('[store]', req.method, url.pathname, e)
    if (res.headersSent) {
      res.end()
      return
    }
    // A browser navigating to a missing page should see the site's own 404, not JSON.
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html')
    if (status === 404 && wantsHtml && existsSync(join(PUBLIC_DIR, '404.html'))) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(join(PUBLIC_DIR, '404.html')))
      return
    }
    json(res, status, { error: e.message || 'Something went wrong.' })
  }
})

// Keep uploads from being cut off by the default 2-minute socket timeout.
server.requestTimeout = 10 * 60 * 1000
server.headersTimeout = 65_000

server.listen(PORT, HOST, () => {
  console.log(`${SITE_NAME} → http://${HOST}:${PORT}`)
  console.log(`  storage: ${ASSETS_DIR}`)
  console.log(`  google sign-in: ${GOOGLE_ENABLED ? 'enabled' : 'not configured'}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush()
    server.close(() => process.exit(0))
    // Don't hang on a keep-alive connection when the user is trying to stop the server.
    setTimeout(() => process.exit(0), 1500).unref()
  })
}

export { server }
