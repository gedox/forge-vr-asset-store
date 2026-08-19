// The Forge VR Asset Store as a single Vercel serverless function.
//
// The local development server (server/index.js) is a node:http process with a file-based
// database. Vercel cannot run that: it is serverless with a read-only filesystem. This
// handler is the same API, backed by PostgreSQL (Neon) for metadata and Vercel Blob for
// the .glb / .png files. The static site in public/ is served by Vercel directly.
//
//   - DATABASE_URL            PostgreSQL connection string (Neon / Vercel Postgres)
//   - BLOB_READ_WRITE_TOKEN   Vercel Blob read-write token
//   - PUBLIC_URL              public origin, used for Google OAuth redirects (optional —
//                             derived from the request when unset)
//   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   enables Google sign-in
//
// See schema.sql for the tables, and README.md for the full setup.

import { neon } from '@neondatabase/serverless'
import { put, del } from '@vercel/blob'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { crc32 } from 'node:zlib'

// --- config ------------------------------------------------------------------
const SECTIONS = ['props', 'characters', 'custom']
const MAX_ASSET_BYTES = Number(process.env.MAX_ASSET_BYTES || 25 * 1024 * 1024)
const MAX_THUMB_BYTES = Number(process.env.MAX_THUMB_BYTES || 2 * 1024 * 1024)
const MAX_PACK_BYTES = Number(process.env.MAX_PACK_BYTES || 500 * 1024 * 1024)
const MAX_ASSETS_PER_PACK = Number(process.env.MAX_ASSETS_PER_PACK || 300)
const MAX_COVER_ASSETS = 7
const MAX_JSON_BYTES = 256 * 1024
const SESSION_COOKIE = 'forge_store_sid'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30
const OAUTH_STATE_COOKIE = 'forge_store_oauth'
const SITE_NAME = 'Forge VR Asset Store'

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
const sql = databaseUrl ? neon(databaseUrl) : null

// --- small HTTP helpers (mirror server/http.js) ------------------------------
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const badRequest = (m) => new HttpError(400, m)
const unauthorized = (m = 'Sign in first.') => new HttpError(401, m)
const forbidden = (m = 'That is not yours.') => new HttpError(403, m)
const notFound = (m = 'Not found.') => new HttpError(404, m)
const conflict = (m) => new HttpError(409, m)
const tooLarge = (m) => new HttpError(413, m)

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function noContent(res) {
  res.writeHead(204)
  res.end()
}

function redirect(res, location) {
  res.writeHead(302, { location })
  res.end()
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setCookie(res, req, name, value, { maxAge, httpOnly = true, sameSite = 'Lax' } = {}) {
  const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https'
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`)
  const existing = res.getHeader('set-cookie')
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : []
  res.setHeader('set-cookie', [...list, parts.join('; ')])
}

function clearCookie(res, req, name) {
  setCookie(res, req, name, '', { maxAge: 0 })
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (declared && declared > limitBytes) {
      reject(tooLarge(`Body is ${(declared / 1048576).toFixed(1)} MB; the limit is ${(limitBytes / 1048576).toFixed(0)} MB.`))
      req.destroy()
      return
    }
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(tooLarge(`Body exceeds the ${(limitBytes / 1048576).toFixed(0)} MB limit.`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf-8'))
  } catch {
    throw badRequest('Body was not valid JSON.')
  }
}

function headerText(req, name, fallback = '') {
  const raw = req.headers[name]
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function match(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean)
  const u = pathname.split('/').filter(Boolean)
  if (p.length !== u.length) return null
  const params = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(u[i])
    else if (p[i] !== u[i]) return null
  }
  return params
}

// --- ids / time --------------------------------------------------------------
const id = () => randomUUID().replace(/-/g, '').slice(0, 20)
const now = () => new Date().toISOString()
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v || '[]') : v || [])

// --- auth --------------------------------------------------------------------
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${derived}`
}

function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt:')) return false
  const [, salt, expected] = stored.split(':')
  const actual = scryptSync(password, salt, 64).toString('hex')
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,24}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email || undefined,
    username: user.username || undefined,
    displayName: user.display_name || user.username || (user.email ? user.email.split('@')[0] : ''),
    avatarUrl: user.avatar_url || undefined
  }
}

async function findUserByUsername(username) {
  const target = String(username || '').trim().toLowerCase()
  const rows = await sql.query('SELECT * FROM users WHERE LOWER(username) = $1', [target])
  return rows[0] || null
}

async function findUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase()
  const rows = await sql.query('SELECT * FROM users WHERE LOWER(email) = $1', [target])
  return rows[0] || null
}

async function findUserById(userId) {
  const rows = await sql.query('SELECT * FROM users WHERE id = $1', [userId])
  return rows[0] || null
}

async function registerUser({ username, password }) {
  const clean = String(username || '').trim()
  if (!USERNAME_RE.test(clean)) throw badRequest('Use a username of 2–24 letters, numbers, dots, dashes or underscores.')
  if (!password || String(password).length < 8) throw badRequest('Use a password of at least 8 characters.')
  if (await findUserByUsername(clean)) throw conflict('That username is already taken.')
  const rows = await sql.query(
    'INSERT INTO users (id, username, display_name, password_hash, provider, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [id(), clean, clean, hashPassword(String(password)), 'password', now()]
  )
  return rows[0]
}

async function loginUser({ username, password }) {
  const user = await findUserByUsername(username)
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw unauthorized('Username or password is wrong.')
  }
  return user
}

async function upsertGoogleUser({ email, name, picture, sub }) {
  const clean = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(clean)) throw badRequest('Google returned no usable email address.')
  let user = await findUserByEmail(clean)
  if (!user) {
    const rows = await sql.query(
      'INSERT INTO users (id, email, display_name, provider, google_id, avatar_url, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [id(), clean, name || clean.split('@')[0], 'google', sub || '', picture || '', now()]
    )
    return rows[0]
  }
  const rows = await sql.query(
    'UPDATE users SET google_id = COALESCE(NULLIF($1, \'\'), google_id), avatar_url = COALESCE(NULLIF($2, \'\'), avatar_url), display_name = COALESCE(NULLIF($3, \'\'), display_name) WHERE id = $4 RETURNING *',
    [sub || '', picture || '', name || '', user.id]
  )
  return rows[0]
}

async function createSession(userId) {
  const session = { id: randomUUID() + randomBytes(16).toString('hex'), user_id: userId, created_at: now(), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() }
  await sql.query('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    session.id,
    session.user_id,
    session.created_at,
    session.expires_at
  ])
  return session
}

async function destroySession(sessionId) {
  await sql.query('DELETE FROM sessions WHERE id = $1', [sessionId])
}

async function sessionUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const rows = await sql.query('SELECT * FROM sessions WHERE id = $1', [sid])
  const session = rows[0]
  if (!session) return null
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await destroySession(sid)
    return null
  }
  return findUserById(session.user_id)
}

const KEY_PREFIX = 'fvs_'
const digest = (key) => createHash('sha256').update(key).digest('hex')

async function createApiKey(userId, label) {
  const key = KEY_PREFIX + randomBytes(24).toString('hex')
  const record = {
    id: id(),
    user_id: userId,
    label: String(label || '').trim() || 'Forge desktop',
    hash: digest(key),
    hint: key.slice(0, KEY_PREFIX.length + 4),
    created_at: now(),
    last_used_at: null
  }
  await sql.query('INSERT INTO api_keys (id, user_id, label, hash, hint, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
    record.id,
    record.user_id,
    record.label,
    record.hash,
    record.hint,
    record.created_at
  ])
  return { record, key }
}

async function listApiKeys(userId) {
  const rows = await sql.query('SELECT id, label, hint, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId])
  return rows.map(({ id: keyId, label, hint, created_at, last_used_at }) => ({ id: keyId, label, hint, createdAt: created_at, lastUsedAt: last_used_at }))
}

async function deleteApiKey(userId, keyId) {
  const rows = await sql.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id', [keyId, userId])
  return rows.length > 0
}

async function apiKeyUser(req) {
  const header = req.headers.authorization || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const rows = await sql.query('SELECT * FROM api_keys WHERE hash = $1', [digest(m[1].trim())])
  const record = rows[0]
  if (!record) return null
  await sql.query('UPDATE api_keys SET last_used_at = $1 WHERE id = $2', [now(), record.id])
  return findUserById(record.user_id)
}

async function currentUser(req) {
  return (await apiKeyUser(req)) || (await sessionUser(req))
}

async function requireUser(req) {
  const user = await currentUser(req)
  if (!user) throw unauthorized()
  return user
}

function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  return `${proto}://${req.headers.host}`
}

function googleAuthUrl(state, req) {
  const redirectUri = publicUrl(req) + '/api/auth/google/callback'
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function googleExchange(code, req) {
  if (!GOOGLE_ENABLED) throw badRequest('Google sign-in is not configured on this server.')
  const redirectUri = publicUrl(req) + '/api/auth/google/callback'
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })
  if (!tokenRes.ok) throw badRequest(`Google refused the code exchange: ${(await tokenRes.text()).slice(0, 200)}`)
  const tokens = await tokenRes.json()
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` }
  })
  if (!infoRes.ok) throw badRequest('Google would not return the profile for that token.')
  const info = await infoRes.json()
  if (!info.email_verified) throw badRequest('That Google account has no verified email address.')
  return info
}

// --- packs -------------------------------------------------------------------
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pack'
}

async function uniqueSlug(base) {
  const rows = await sql.query('SELECT 1 AS x FROM packs WHERE slug = $1', [base])
  if (!rows.length) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    const r = await sql.query('SELECT 1 AS x FROM packs WHERE slug = $1', [candidate])
    if (!r.length) return candidate
  }
}

function assertGlb(buffer) {
  if (buffer.length < 20) throw badRequest('That file is too small to be a .glb.')
  if (buffer.toString('ascii', 0, 4) !== 'glTF') throw badRequest('That is not a .glb file — the glTF binary header is missing.')
  const version = buffer.readUInt32LE(4)
  if (version !== 2) throw badRequest(`Only glTF 2.0 binaries are accepted (this one is version ${version}).`)
  const declared = buffer.readUInt32LE(8)
  if (declared !== buffer.length) throw badRequest('The .glb header length does not match the file — it arrived truncated.')
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function assertPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) throw badRequest('Previews must be PNG images.')
}

async function packsOf(userId) {
  return sql.query('SELECT * FROM packs WHERE user_id = $1', [userId])
}

async function findPack(packIdOrSlug) {
  const rows = await sql.query('SELECT * FROM packs WHERE id = $1 OR slug = $1', [packIdOrSlug])
  return rows[0] || null
}

async function assetsOf(packId) {
  return sql.query('SELECT * FROM assets WHERE pack_id = $1 ORDER BY created_at ASC', [packId])
}

async function ownedPack(user, packIdOrSlug) {
  const pack = await findPack(packIdOrSlug)
  if (!pack) throw notFound('No such pack.')
  if (pack.user_id !== user.id) throw forbidden('That pack belongs to someone else.')
  return pack
}

async function nameTaken(userId, name, exceptPackId = null) {
  const target = String(name || '').trim().toLowerCase()
  const rows = await sql.query('SELECT id FROM packs WHERE user_id = $1 AND LOWER(name) = $2', [userId, target])
  return rows.some((p) => p.id !== exceptPackId)
}

async function packBytes(packId) {
  const rows = await sql.query('SELECT COALESCE(SUM(size_bytes), 0)::int AS total FROM assets WHERE pack_id = $1', [packId])
  return rows[0]?.total ?? 0
}

async function createPack(user, { name, section, description }) {
  const clean = String(name || '').trim()
  if (!clean) throw badRequest('A pack needs a name.')
  if (clean.length > 80) throw badRequest('Pack names stop at 80 characters.')
  if (await nameTaken(user.id, clean)) throw conflict(`You already have a pack called "${clean}". Add to that one, or pick another name.`)
  const sect = SECTIONS.includes(section) ? section : 'props'
  const pack = {
    id: id(),
    user_id: user.id,
    name: clean,
    slug: await uniqueSlug(slugify(clean)),
    section: sect,
    description: String(description || '').trim().slice(0, 600),
    cover_asset_ids: [],
    created_at: now(),
    updated_at: now()
  }
  await sql.query(
    'INSERT INTO packs (id, user_id, name, slug, section, description, cover_asset_ids, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [pack.id, pack.user_id, pack.name, pack.slug, pack.section, pack.description, JSON.stringify([]), pack.created_at, pack.updated_at]
  )
  return pack
}

async function updatePack(user, packIdOrSlug, patch) {
  const pack = await ownedPack(user, packIdOrSlug)
  const sets = []
  const vals = []
  let n = 1
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim()
    if (!clean) throw badRequest('A pack needs a name.')
    if (await nameTaken(user.id, clean, pack.id)) throw conflict(`You already have a pack called "${clean}".`)
    pack.name = clean.slice(0, 80)
    sets.push(`name = $${n++}`)
    vals.push(pack.name)
  }
  if (patch.section !== undefined) {
    if (!SECTIONS.includes(patch.section)) throw badRequest('Unknown section.')
    pack.section = patch.section
    sets.push(`section = $${n++}`)
    vals.push(pack.section)
  }
  if (patch.description !== undefined) {
    pack.description = String(patch.description).trim().slice(0, 600)
    sets.push(`description = $${n++}`)
    vals.push(pack.description)
  }
  if (patch.coverAssetIds !== undefined) {
    const assets = await assetsOf(pack.id)
    const owned = new Set(assets.map((a) => a.id))
    pack.cover_asset_ids = (Array.isArray(patch.coverAssetIds) ? patch.coverAssetIds : [])
      .filter((assetId) => owned.has(assetId))
      .slice(0, MAX_COVER_ASSETS)
    sets.push(`cover_asset_ids = $${n++}`)
    vals.push(JSON.stringify(pack.cover_asset_ids))
  }
  pack.updated_at = now()
  sets.push(`updated_at = $${n++}`)
  vals.push(pack.updated_at)
  vals.push(pack.id)
  await sql.query(`UPDATE packs SET ${sets.join(', ')} WHERE id = $${n}`, vals)
  return pack
}

async function deletePack(user, packIdOrSlug) {
  const pack = await ownedPack(user, packIdOrSlug)
  const assets = await assetsOf(pack.id)
  for (const asset of assets) await removeBlobFiles(asset)
  await sql.query('DELETE FROM packs WHERE id = $1', [pack.id])
}

async function removeBlobFiles(asset) {
  try {
    await del(['assets/' + asset.id + '.glb', 'thumbs/' + asset.id + '.png'])
  } catch {
    /* a stranded blob is better than a failed delete */
  }
}

async function addAsset(user, packIdOrSlug, buffer, meta) {
  const pack = await ownedPack(user, packIdOrSlug)
  assertGlb(buffer)

  const existing = await assetsOf(pack.id)
  if (existing.length >= MAX_ASSETS_PER_PACK) throw tooLarge(`A pack holds at most ${MAX_ASSETS_PER_PACK} assets.`)
  if ((await packBytes(pack.id)) + buffer.length > MAX_PACK_BYTES) {
    throw tooLarge(`That would push the pack past its ${(MAX_PACK_BYTES / 1048576).toFixed(0)} MB total.`)
  }

  const name = String(meta.name || '').trim().slice(0, 120) || 'untitled asset'
  const fileName = (String(meta.fileName || '').trim() || slugify(name) + '.glb').replace(/[^a-zA-Z0-9._-]/g, '_')
  const sourceId = String(meta.sourceId || '').trim()

  const previous = sourceId ? existing.find((a) => a.source_id === sourceId) : null
  if (previous) {
    const blob = await put('assets/' + previous.id + '.glb', buffer, {
      access: 'public',
      contentType: 'model/gltf-binary'
    })
    const res = await sql.query(
      'UPDATE assets SET name = $1, file_name = $2, size_bytes = $3, triangles = $4, category = $5, file_url = $6, updated_at = $7 WHERE id = $8 RETURNING *',
      [name, fileName, buffer.length, Number(meta.triangles) || previous.triangles || 0, meta.category || previous.category || 'prop', blob.url, now(), previous.id]
    )
    await touchPack(pack.id)
    return res.rows[0]
  }

  const asset = {
    id: id(),
    pack_id: pack.id,
    user_id: user.id,
    name,
    file_name: fileName,
    size_bytes: buffer.length,
    triangles: Number(meta.triangles) || 0,
    category: meta.category || 'prop',
    source_id: sourceId,
    has_thumb: false,
    file_url: '',
    thumb_url: '',
    created_at: now(),
    updated_at: now()
  }
  const blob = await put('assets/' + asset.id + '.glb', buffer, { access: 'public', contentType: 'model/gltf-binary' })
  asset.file_url = blob.url
  await sql.query(
    'INSERT INTO assets (id, pack_id, user_id, name, file_name, size_bytes, triangles, category, source_id, has_thumb, file_url, thumb_url, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [asset.id, asset.pack_id, asset.user_id, asset.name, asset.file_name, asset.size_bytes, asset.triangles, asset.category, asset.source_id, asset.has_thumb, asset.file_url, asset.thumb_url, asset.created_at, asset.updated_at]
  )

  const covers = asArray(pack.cover_asset_ids)
  if (covers.length < MAX_COVER_ASSETS) {
    covers.push(asset.id)
    await sql.query('UPDATE packs SET cover_asset_ids = $1, updated_at = $2 WHERE id = $3', [JSON.stringify(covers), now(), pack.id])
  } else {
    await touchPack(pack.id)
  }
  return asset
}

async function touchPack(packId) {
  await sql.query('UPDATE packs SET updated_at = $1 WHERE id = $2', [now(), packId])
}

async function setAssetThumb(user, packIdOrSlug, assetId, buffer) {
  const pack = await ownedPack(user, packIdOrSlug)
  assertPng(buffer)
  const assets = await assetsOf(pack.id)
  const asset = assets.find((a) => a.id === assetId)
  if (!asset) throw notFound('No such asset in that pack.')
  const blob = await put('thumbs/' + asset.id + '.png', buffer, { access: 'public', contentType: 'image/png' })
  const res = await sql.query(
    'UPDATE assets SET has_thumb = true, thumb_url = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [blob.url, now(), asset.id]
  )
  await touchPack(pack.id)
  return res.rows[0]
}

async function removeAsset(user, packIdOrSlug, assetId) {
  const pack = await ownedPack(user, packIdOrSlug)
  const assets = await assetsOf(pack.id)
  const asset = assets.find((a) => a.id === assetId)
  if (!asset) throw notFound('No such asset in that pack.')
  await removeBlobFiles(asset)
  await sql.query('DELETE FROM assets WHERE id = $1', [asset.id])
  let covers = asArray(pack.cover_asset_ids).filter((c) => c !== asset.id)
  if (covers.length === 0) {
    covers = (await assetsOf(pack.id)).slice(0, MAX_COVER_ASSETS).map((a) => a.id)
  }
  await sql.query('UPDATE packs SET cover_asset_ids = $1, updated_at = $2 WHERE id = $3', [JSON.stringify(covers), now(), pack.id])
}

function publicAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    fileName: asset.file_name,
    sizeBytes: asset.size_bytes,
    triangles: asset.triangles || undefined,
    category: asset.category,
    thumbUrl: asset.has_thumb ? asset.thumb_url : undefined,
    fileUrl: asset.file_url
  }
}

async function publicPack(pack, { withAssets = true } = {}) {
  const assets = await assetsOf(pack.id)
  const ownerRows = await sql.query('SELECT id, display_name, avatar_url FROM users WHERE id = $1', [pack.user_id])
  const owner = ownerRows[0] || null
  const covers = asArray(pack.cover_asset_ids).filter((id) => assets.some((a) => a.id === id))
  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    section: pack.section,
    description: pack.description,
    assetCount: assets.length,
    totalBytes: assets.reduce((n, a) => n + a.size_bytes, 0),
    createdAt: pack.created_at,
    updatedAt: pack.updated_at,
    coverAssetIds: covers.length ? covers : assets.slice(0, MAX_COVER_ASSETS).map((a) => a.id),
    owner: owner ? { id: owner.id, displayName: owner.display_name || owner.id, avatarUrl: owner.avatar_url || undefined } : null,
    assets: withAssets ? assets.map(publicAsset) : undefined
  }
}

// --- zip ---------------------------------------------------------------------
function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const data = entry.data
    const crc = crc32(data)
    const { time, day } = dosTime(entry.date ?? new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(0, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(day, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([dir, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

// --- router ------------------------------------------------------------------
async function startSession(res, req, user) {
  const session = await createSession(user.id)
  setCookie(res, req, SESSION_COOKIE, session.id, { maxAge: SESSION_TTL_MS })
}

async function downloadPack(res, req, params) {
  const pack = await findPack(params.id)
  if (!pack) throw notFound('No such pack.')
  const assets = await assetsOf(pack.id)
  if (!assets.length) throw notFound('That pack has no assets yet.')
  const seen = new Map()
  const entries = []
  for (const asset of assets) {
    const count = (seen.get(asset.file_name) ?? 0) + 1
    seen.set(asset.file_name, count)
    const name = count === 1 ? asset.file_name : asset.file_name.replace(/(\.glb)?$/i, `-${count}$1`)
    let data
    try {
      const r = await fetch(asset.file_url)
      if (!r.ok) throw new Error('blob fetch failed')
      data = Buffer.from(await r.arrayBuffer())
    } catch {
      continue
    }
    entries.push({ name: `${pack.slug}/${name}`, data, date: new Date(asset.created_at) })
  }
  entries.push({ name: `${pack.slug}/pack.json`, data: Buffer.from(JSON.stringify(await publicPack(pack)), 'utf-8') })
  const zip = buildZip(entries)
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': zip.length,
    'content-disposition': `attachment; filename="${pack.slug}.zip"`
  })
  res.end(zip)
}

export default async function handler(req, res) {
  if (!sql) {
    json(res, 500, {
      error:
        'Database is not configured. Create a Neon (or Vercel Postgres) database, run schema.sql, and set DATABASE_URL — see README.md → "Deploying to Vercel".'
    })
    return
  }
  const url = new URL(req.url, 'http://x')
  let pathname = url.pathname
  const method = req.method

  // Vercel rewrites `/api/:path*` to this function. Depending on how the platform routes,
  // the function either sees the original `/api/packs/x` (rewrites preserve it) or the
  // destination with the captured path passed as the `path` query param. Rebuild the path
  // from whichever is present so nested routes resolve in both cases.
  const rest = url.searchParams.get('path')
  if (rest) pathname = '/api/' + rest

  const routes = [
    ['GET', '/api/health', () => json(res, 200, { ok: true, name: SITE_NAME })],

    ['GET', '/api/config', () =>
      json(res, 200, {
        name: SITE_NAME,
        googleEnabled: GOOGLE_ENABLED,
        sections: SECTIONS,
        limits: { maxAssetBytes: MAX_ASSET_BYTES, maxPackBytes: MAX_PACK_BYTES, maxAssetsPerPack: MAX_ASSETS_PER_PACK, maxCoverAssets: MAX_COVER_ASSETS }
      })],

    ['POST', '/api/auth/register', async () => {
      const body = await readJson(req, MAX_JSON_BYTES)
      const user = await registerUser(body)
      await startSession(res, req, user)
      json(res, 201, { user: publicUser(user) })
    }],

    ['POST', '/api/auth/login', async () => {
      const body = await readJson(req, MAX_JSON_BYTES)
      const user = await loginUser(body)
      await startSession(res, req, user)
      json(res, 200, { user: publicUser(user) })
    }],

    ['POST', '/api/auth/logout', async () => {
      const sid = parseCookies(req)[SESSION_COOKIE]
      if (sid) await destroySession(sid)
      clearCookie(res, req, SESSION_COOKIE)
      noContent(res)
    }],

    ['GET', '/api/me', async () => {
      const user = await requireUser(req)
      json(res, 200, { user: publicUser(user) })
    }],

    ['GET', '/api/auth/google', () => {
      if (!GOOGLE_ENABLED) throw badRequest('Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
      const state = randomBytes(16).toString('hex')
      setCookie(res, req, OAUTH_STATE_COOKIE, state, { maxAge: 10 * 60 * 1000 })
      redirect(res, googleAuthUrl(state, req))
    }],

    ['GET', '/api/auth/google/callback', async () => {
      const state = url.searchParams.get('state')
      const expected = parseCookies(req)[OAUTH_STATE_COOKIE]
      if (!state || !expected || state !== expected) throw badRequest('The sign-in did not come back the way it left. Try again.')
      clearCookie(res, req, OAUTH_STATE_COOKIE)
      const code = url.searchParams.get('code')
      if (!code) throw badRequest(url.searchParams.get('error') || 'Google returned no authorisation code.')
      const info = await googleExchange(code, req)
      const user = await upsertGoogleUser(info)
      await startSession(res, req, user)
      redirect(res, '/profile.html')
    }],

    ['GET', '/api/keys', async () => {
      json(res, 200, { keys: await listApiKeys((await requireUser(req)).id) })
    }],

    ['POST', '/api/keys', async () => {
      const user = await requireUser(req)
      const body = await readJson(req, MAX_JSON_BYTES)
      const { record, key } = await createApiKey(user.id, body.label)
      json(res, 201, { key, record: { id: record.id, label: record.label, hint: record.hint, createdAt: record.created_at } })
    }],

    ['DELETE', '/api/keys/:id', async ({ params }) => {
      const user = await requireUser(req)
      if (!(await deleteApiKey(user.id, params.id))) throw notFound('No such key.')
      noContent(res)
    }],

    ['GET', '/api/packs', async () => {
      const section = url.searchParams.get('section') || 'all'
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const sort = url.searchParams.get('sort') || 'newest'
      const all = await sql.query('SELECT * FROM packs')
      let list = all
      if (SECTIONS.includes(section)) list = list.filter((p) => p.section === section)
      if (q) {
        const filtered = []
        for (const p of list) {
          const assets = await assetsOf(p.id)
          const haystack = [p.name, p.description, ...assets.map((a) => a.name)].join(' ').toLowerCase()
          if (haystack.includes(q)) filtered.push(p)
        }
        list = filtered
      }
      const shaped = []
      for (const p of list) shaped.push(await publicPack(p, { withAssets: true }))
      shaped.sort((a, b) => {
        if (sort === 'largest') return b.assetCount - a.assetCount
        if (sort === 'name') return a.name.localeCompare(b.name)
        return new Date(b.updatedAt) - new Date(a.updatedAt)
      })
      json(res, 200, {
        packs: shaped,
        counts: {
          all: all.length,
          ...Object.fromEntries(SECTIONS.map((s) => [s, all.filter((p) => p.section === s).length]))
        }
      })
    }],

    ['GET', '/api/me/packs', async () => {
      const user = await requireUser(req)
      const packs = await packsOf(user.id)
      const shaped = []
      for (const p of packs) shaped.push(await publicPack(p))
      shaped.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      json(res, 200, { packs: shaped })
    }],

    ['POST', '/api/packs', async () => {
      const user = await requireUser(req)
      const body = await readJson(req, MAX_JSON_BYTES)
      json(res, 201, { pack: await publicPack(await createPack(user, body)) })
    }],

    ['GET', '/api/packs/:id', async ({ params }) => {
      const pack = await findPack(params.id)
      if (!pack) throw notFound('No such pack.')
      json(res, 200, { pack: await publicPack(pack) })
    }],

    ['PATCH', '/api/packs/:id', async ({ params }) => {
      const user = await requireUser(req)
      const body = await readJson(req, MAX_JSON_BYTES)
      json(res, 200, { pack: await publicPack(await updatePack(user, params.id, body)) })
    }],

    ['DELETE', '/api/packs/:id', async ({ params }) => {
      await deletePack(await requireUser(req), params.id)
      noContent(res)
    }],

    ['POST', '/api/packs/:id/assets', async ({ params }) => {
      const user = await requireUser(req)
      const buffer = await readBody(req, MAX_ASSET_BYTES)
      const asset = await addAsset(user, params.id, buffer, {
        name: headerText(req, 'x-asset-name'),
        fileName: headerText(req, 'x-asset-filename'),
        category: headerText(req, 'x-asset-category', 'prop'),
        triangles: headerText(req, 'x-asset-triangles', '0'),
        sourceId: headerText(req, 'x-asset-source-id')
      })
      json(res, 201, { asset: publicAsset(asset) })
    }],

    ['POST', '/api/packs/:id/assets/:assetId/thumb', async ({ params }) => {
      const user = await requireUser(req)
      const buffer = await readBody(req, MAX_THUMB_BYTES)
      const asset = await setAssetThumb(user, params.id, params.assetId, buffer)
      json(res, 200, { asset: publicAsset(asset) })
    }],

    ['DELETE', '/api/packs/:id/assets/:assetId', async ({ params }) => {
      await removeAsset(await requireUser(req), params.id, params.assetId)
      noContent(res)
    }],

    ['GET', '/api/packs/:id/download', async ({ params }) => {
      await downloadPack(res, req, params)
    }]
  ]

  try {
    for (const [routeMethod, pattern, fn] of routes) {
      if (method !== routeMethod) continue
      const params = match(pattern, pathname)
      if (!params) continue
      await fn({ params })
      return
    }
    throw notFound(`No route for ${method} ${pathname}`)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status >= 500) console.error('[store:vercel]', method, pathname, e)
    if (res.headersSent) {
      res.end()
      return
    }
    json(res, status, { error: e.message || 'Something went wrong.' })
  }
}
