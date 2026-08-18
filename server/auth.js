// Accounts, sessions and API keys.
//
// Three ways in, all landing on the same user record:
//   password  — scrypt with a per-user salt
//   Google    — OAuth 2.0 authorisation code flow, matched to a user by verified email
//   API key   — for the Forge desktop app, which has no browser to log in with
//
// Passwords are never stored, API keys are stored only as SHA-256 digests, and the plain
// key is shown to its owner exactly once, at creation.

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_ENABLED,
  GOOGLE_REDIRECT_URI,
  SESSION_COOKIE,
  SESSION_TTL_MS
} from './config.js'
import { db, id, now, save } from './db.js'
import { badRequest, conflict, parseCookies, unauthorized } from './http.js'

// --- passwords ---------------------------------------------------------------
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

// --- users -------------------------------------------------------------------
export function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email || undefined,
    username: user.username || undefined,
    displayName: user.displayName || user.username || (user.email ? user.email.split('@')[0] : ''),
    avatarUrl: user.avatarUrl || undefined
  }
}

export function findUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase()
  return db().users.find((u) => u.email === target) || null
}

export function findUserByUsername(username) {
  const target = String(username || '').trim().toLowerCase()
  return db().users.find((u) => (u.username || '').toLowerCase() === target) || null
}

export function findUser(userId) {
  return db().users.find((u) => u.id === userId) || null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,24}$/

export function registerUser({ username, password }) {
  const clean = String(username || '').trim()
  if (!USERNAME_RE.test(clean)) {
    throw badRequest('Use a username of 2–24 letters, numbers, dots, dashes or underscores.')
  }
  if (!password || String(password).length < 8) {
    throw badRequest('Use a password of at least 8 characters.')
  }
  if (findUserByUsername(clean)) throw conflict('That username is already taken.')
  const user = {
    id: id(),
    email: '',
    username: clean,
    displayName: clean,
    passwordHash: hashPassword(String(password)),
    provider: 'password',
    avatarUrl: '',
    createdAt: now()
  }
  db().users.push(user)
  save({ immediate: true })
  return user
}

export function loginUser({ username, password }) {
  const user = findUserByUsername(username)
  // Same message either way: telling an unauthenticated caller which half was wrong hands
  // them a way to enumerate accounts.
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    throw unauthorized('Username or password is wrong.')
  }
  return user
}

export function upsertGoogleUser({ email, name, picture, sub }) {
  const clean = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(clean)) throw badRequest('Google returned no usable email address.')
  let user = findUserByEmail(clean)
  if (!user) {
    user = {
      id: id(),
      email: clean,
      displayName: name || clean.split('@')[0],
      passwordHash: '',
      provider: 'google',
      googleId: sub || '',
      avatarUrl: picture || '',
      createdAt: now()
    }
    db().users.push(user)
  } else {
    // An existing password account signing in with the same verified email is the same
    // person; link rather than fork.
    user.googleId = sub || user.googleId
    if (picture) user.avatarUrl = picture
    if (!user.displayName && name) user.displayName = name
  }
  save({ immediate: true })
  return user
}

// --- sessions ----------------------------------------------------------------
export function createSession(userId) {
  const session = {
    id: randomUUID() + randomBytes(16).toString('hex'),
    userId,
    createdAt: now(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  }
  db().sessions.push(session)
  save({ immediate: true })
  return session
}

export function destroySession(sessionId) {
  const store = db()
  store.sessions = store.sessions.filter((s) => s.id !== sessionId)
  save({ immediate: true })
}

function sessionUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const session = db().sessions.find((s) => s.id === sid)
  if (!session) return null
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    destroySession(sid)
    return null
  }
  return findUser(session.userId)
}

// --- API keys ----------------------------------------------------------------
const KEY_PREFIX = 'fvs_'

function digest(key) {
  return createHash('sha256').update(key).digest('hex')
}

export function createApiKey(userId, label) {
  const key = KEY_PREFIX + randomBytes(24).toString('hex')
  const record = {
    id: id(),
    userId,
    label: String(label || '').trim() || 'Forge desktop',
    hash: digest(key),
    // Enough of the key to recognise it in a list, never enough to use it.
    hint: key.slice(0, KEY_PREFIX.length + 4),
    createdAt: now(),
    lastUsedAt: ''
  }
  db().apiKeys.push(record)
  save({ immediate: true })
  return { record, key }
}

export function listApiKeys(userId) {
  return db()
    .apiKeys.filter((k) => k.userId === userId)
    .map(({ id: keyId, label, hint, createdAt, lastUsedAt }) => ({ id: keyId, label, hint, createdAt, lastUsedAt }))
}

export function deleteApiKey(userId, keyId) {
  const store = db()
  const before = store.apiKeys.length
  store.apiKeys = store.apiKeys.filter((k) => !(k.id === keyId && k.userId === userId))
  if (store.apiKeys.length === before) return false
  save({ immediate: true })
  return true
}

function apiKeyUser(req) {
  const header = req.headers.authorization || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const record = db().apiKeys.find((k) => k.hash === digest(m[1].trim()))
  if (!record) return null
  record.lastUsedAt = now()
  save()
  return findUser(record.userId)
}

// --- request authentication --------------------------------------------------
// Either credential works everywhere: the website sends a session cookie, the desktop app
// sends a bearer key, and handlers below this line never need to know which.
export function currentUser(req) {
  return apiKeyUser(req) || sessionUser(req)
}

export function requireUser(req) {
  const user = currentUser(req)
  if (!user) throw unauthorized()
  return user
}

// --- Google OAuth ------------------------------------------------------------
export function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export async function googleExchange(code) {
  if (!GOOGLE_ENABLED) throw badRequest('Google sign-in is not configured on this server.')
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  })
  if (!tokenRes.ok) {
    throw badRequest(`Google refused the code exchange: ${(await tokenRes.text()).slice(0, 200)}`)
  }
  const tokens = await tokenRes.json()
  // The profile is read back from Google with the access token rather than decoded out of
  // the id_token here: that way the claims are ones Google just handed us directly, and
  // there is no JWT signature to verify by hand.
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` }
  })
  if (!infoRes.ok) throw badRequest('Google would not return the profile for that token.')
  const info = await infoRes.json()
  if (!info.email_verified) throw badRequest('That Google account has no verified email address.')
  return info
}
