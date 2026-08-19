#!/usr/bin/env node
// "sforge sync" — push the local store up to the deployed (Vercel) backend.
//
// The local server (server/index.js) keeps everything in storage/db.json plus the .glb and
// .png files on disk. The deployed site (api/[...path].js) keeps metadata in Neon Postgres
// and the files in Vercel Blob. Those two stores never meet on their own: pushing code to
// GitHub moves source, not data. This script is the bridge.
//
// It reads storage/db.json and the files next to it, then upserts the same rows into the
// database (preserving ids, password hashes and API-key digests so nothing breaks) and
// uploads any files the database does not already have. It is idempotent — re-running it
// only pushes what changed.
//
// Credentials come from .env (or the environment):
//   DATABASE_URL            Neon / Vercel Postgres connection string
//   BLOB_READ_WRITE_TOKEN   Vercel Blob read-write token
//   FORGE_STORE_STORAGE     optional, where the local store lives (default ./storage)

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- tiny .env loader (no dependency; .env is gitignored) --------------------
function loadEnv(file) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnv(join(root, '.env'))

const STORAGE_DIR = process.env.FORGE_STORE_STORAGE || join(root, 'storage')
const DB_FILE = join(STORAGE_DIR, 'db.json')
const ASSETS_DIR = join(STORAGE_DIR, 'assets')
const THUMBS_DIR = join(STORAGE_DIR, 'thumbs')
const SCHEMA_FILE = join(root, 'schema.sql')

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || ''

const NONE = { version: 1, users: [], packs: [], assets: [], sessions: [], apiKeys: [] }

function readDb() {
  if (!existsSync(DB_FILE)) return structuredClone(NONE)
  try {
    const parsed = JSON.parse(readFileSync(DB_FILE, 'utf-8').replace(/^\uFEFF/, ''))
    return { ...structuredClone(NONE), ...parsed }
  } catch (e) {
    console.error(`[sync] could not read ${DB_FILE}: ${e.message}`)
    process.exit(1)
  }
}

const asTimestamp = (iso) => (iso ? iso : null)
const jsonb = (arr) => JSON.stringify(arr || [])

// Every DDL statement in schema.sql is a CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS, so running it here makes the sync self-sufficient (no manual first deploy).
async function ensureSchema(sql) {
  const source = readFileSync(SCHEMA_FILE, 'utf-8')
  const statements = source
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length)
  for (const stmt of statements) {
    await sql.query(stmt)
  }
}

async function upsertUsers(sql, users) {
  if (!users.length) return 0
  let n = 0
  for (const u of users) {
    await sql.query(
      `INSERT INTO users (id, email, username, display_name, password_hash, provider, google_id, avatar_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         provider = EXCLUDED.provider,
         google_id = EXCLUDED.google_id,
         avatar_url = EXCLUDED.avatar_url`,
      [u.id, u.email || '', u.username || '', u.displayName || '', u.passwordHash || '', u.provider || 'password', u.googleId || '', u.avatarUrl || '', asTimestamp(u.createdAt)]
    )
    n++
  }
  return n
}

async function upsertApiKeys(sql, keys) {
  if (!keys.length) return 0
  let n = 0
  for (const k of keys) {
    await sql.query(
      `INSERT INTO api_keys (id, user_id, label, hash, hint, created_at, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         hash = EXCLUDED.hash,
         hint = EXCLUDED.hint,
         last_used_at = EXCLUDED.last_used_at`,
      [k.id, k.userId, k.label || '', k.hash || '', k.hint || '', asTimestamp(k.createdAt), asTimestamp(k.lastUsedAt || null)]
    )
    n++
  }
  return n
}

async function upsertPacks(sql, packs) {
  if (!packs.length) return 0
  let n = 0
  for (const p of packs) {
    await sql.query(
      `INSERT INTO packs (id, user_id, name, slug, section, description, cover_asset_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         section = EXCLUDED.section,
         description = EXCLUDED.description,
         cover_asset_ids = EXCLUDED.cover_asset_ids,
         updated_at = EXCLUDED.updated_at`,
      [p.id, p.userId, p.name, p.slug, p.section || 'props', p.description || '', jsonb(p.coverAssetIds), asTimestamp(p.createdAt), asTimestamp(p.updatedAt)]
    )
    n++
  }
  return n
}

async function uploadAssetFiles(asset, existing, stats) {
  // file_url / thumb_url point at Blob. Reuse the existing URL when the database already
  // has a copy and the bytes match — otherwise upload the local file.
  const glbPath = join(ASSETS_DIR, asset.id + '.glb')
  let fileUrl = existing?.file_url || ''
  if (existsSync(glbPath)) {
    if (existing?.file_url && existing.size_bytes === asset.sizeBytes) {
      fileUrl = existing.file_url
      stats.reused++
    } else {
      const blob = await put('assets/' + asset.id + '.glb', readFileSync(glbPath), {
        access: 'public',
        contentType: 'model/gltf-binary',
        token: BLOB_TOKEN
      })
      fileUrl = blob.url
      stats.uploaded++
    }
  }

  let thumbUrl = existing?.thumb_url || ''
  if (asset.hasThumb) {
    const pngPath = join(THUMBS_DIR, asset.id + '.png')
    if (existsSync(pngPath)) {
      if (existing?.thumb_url) {
        thumbUrl = existing.thumb_url
        stats.reused++
      } else {
        const blob = await put('thumbs/' + asset.id + '.png', readFileSync(pngPath), {
          access: 'public',
          contentType: 'image/png',
          token: BLOB_TOKEN
        })
        thumbUrl = blob.url
        stats.uploaded++
      }
    }
  }
  return { fileUrl, thumbUrl }
}

async function upsertAssets(sql, assets) {
  if (!assets.length) return 0
  const existingRows = await sql.query('SELECT * FROM assets')
  const existing = new Map(existingRows.map((a) => [a.id, a]))
  const stats = { uploaded: 0, reused: 0 }
  let n = 0
  for (const a of assets) {
    const prior = existing.get(a.id)
    const { fileUrl, thumbUrl } = await uploadAssetFiles(a, prior, stats)
    await sql.query(
      `INSERT INTO assets (id, pack_id, user_id, name, file_name, size_bytes, triangles, category, source_id, has_thumb, file_url, thumb_url, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         pack_id = EXCLUDED.pack_id,
         user_id = EXCLUDED.user_id,
         name = EXCLUDED.name,
         file_name = EXCLUDED.file_name,
         size_bytes = EXCLUDED.size_bytes,
         triangles = EXCLUDED.triangles,
         category = EXCLUDED.category,
         source_id = EXCLUDED.source_id,
         has_thumb = EXCLUDED.has_thumb,
         file_url = EXCLUDED.file_url,
         thumb_url = EXCLUDED.thumb_url,
         updated_at = EXCLUDED.updated_at`,
      [a.id, a.packId, a.userId, a.name, a.fileName || '', a.sizeBytes || 0, a.triangles || 0, a.category || 'prop', a.sourceId || '', !!a.hasThumb, fileUrl, thumbUrl, asTimestamp(a.createdAt), asTimestamp(a.updatedAt)]
    )
    n++
  }
  if (stats.uploaded) console.log(`[sync]   uploaded ${stats.uploaded} file(s) to Blob, reused ${stats.reused} existing`)
  return n
}

async function main() {
  if (!DB_URL || !BLOB_TOKEN) {
    console.error(`[sync] missing credentials.
  Set DATABASE_URL and BLOB_READ_WRITE_TOKEN in .env (see README.md → "Syncing local → deployed").
  Skipping sync; the push will go ahead without it.`)
    process.exit(0)
  }

  const data = readDb()
  const totals = {
    users: data.users.length,
    apiKeys: data.apiKeys.length,
    packs: data.packs.length,
    assets: data.assets.length
  }
  console.log(`[sync] local store: ${totals.users} user(s), ${totals.packs} pack(s), ${totals.assets} asset(s)`)
  if (!totals.packs && !totals.users && !totals.apiKeys) {
    console.log('[sync] nothing to push. All done.')
    process.exit(0)
  }

  console.log('[sync] connecting to the database…')
  const sql = neon(DB_URL)
  try {
    await ensureSchema(sql)
    console.log('[sync] schema is ready')

    console.log(`[sync] users:      ${await upsertUsers(sql, data.users)}`)
    console.log(`[sync] api keys:   ${await upsertApiKeys(sql, data.apiKeys)}`)
    console.log(`[sync] packs:      ${await upsertPacks(sql, data.packs)}`)
    console.log(`[sync] assets:     ${await upsertAssets(sql, data.assets)}`)
    console.log('[sync] done. The deployed site now shows the same store as this machine.')
  } catch (e) {
    console.error(`[sync] failed: ${e.message}`)
    process.exit(1)
  }
}

main()
