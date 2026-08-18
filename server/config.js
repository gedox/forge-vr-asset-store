// Every knob the store has, in one place. Everything is overridable by environment
// variable so a deployment never needs the source edited.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(here, '..')

export const PORT = Number(process.env.PORT || 4173)
export const HOST = process.env.HOST || '127.0.0.1'

// Where uploads and the database live. Kept outside the source tree by default so a
// `git clean` never deletes someone's library.
export const STORAGE_DIR = process.env.FORGE_STORE_STORAGE || join(ROOT, 'storage')
export const ASSETS_DIR = join(STORAGE_DIR, 'assets')
export const THUMBS_DIR = join(STORAGE_DIR, 'thumbs')
export const DB_FILE = join(STORAGE_DIR, 'db.json')
export const PUBLIC_DIR = join(ROOT, 'public')

// The public origin, used for OAuth redirects. Behind a proxy this must be set.
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')

// --- limits ---
// A game-ready VR prop exported as .glb is a few hundred kilobytes; a dense hero mesh with
// baked textures might reach a few megabytes. 25 MB is roughly fifty times a normal asset:
// far enough out that nothing legitimate is ever refused, close enough in that a mistake
// (a raw scan, a 4K texture set, someone's Blender scene) is caught before it lands.
export const MAX_ASSET_BYTES = Number(process.env.MAX_ASSET_BYTES || 25 * 1024 * 1024)
export const MAX_THUMB_BYTES = Number(process.env.MAX_THUMB_BYTES || 2 * 1024 * 1024)
export const MAX_PACK_BYTES = Number(process.env.MAX_PACK_BYTES || 500 * 1024 * 1024)
export const MAX_ASSETS_PER_PACK = Number(process.env.MAX_ASSETS_PER_PACK || 300)
export const MAX_JSON_BYTES = 256 * 1024
// How many assets a creator can put on a pack's front page.
export const MAX_COVER_ASSETS = 7

export const SECTIONS = ['props', 'characters', 'custom']

// --- auth ---
export const SESSION_COOKIE = 'forge_store_sid'
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
export const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
export const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_URL}/auth/google/callback`

export const SITE_NAME = 'Forge VR Asset Store'
