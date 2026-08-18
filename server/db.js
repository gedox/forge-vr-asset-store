// A single-file JSON database.
//
// The store's whole dataset is a few thousand rows of metadata — users, packs, asset
// records — while the bulk (the .glb files themselves) lives on disk as files. That does
// not need a database engine, and a native one would put a compiler in the way of anyone
// cloning this. Writes are atomic (temp file + rename) so a crash mid-write cannot leave
// a truncated database behind.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ASSETS_DIR, DB_FILE, STORAGE_DIR, THUMBS_DIR } from './config.js'

const EMPTY = {
  version: 1,
  users: [],
  packs: [],
  assets: [],
  sessions: [],
  apiKeys: []
}

let data = null
let writeTimer = null

function ensureDirs() {
  for (const dir of [STORAGE_DIR, ASSETS_DIR, THUMBS_DIR]) mkdirSync(dir, { recursive: true })
}

function load() {
  if (data) return data
  ensureDirs()
  if (existsSync(DB_FILE)) {
    try {
      // Tolerate a UTF-8 BOM: some editors and PowerShell write one, and JSON.parse
      // rejects it outright even though the payload is otherwise fine.
      const raw = readFileSync(DB_FILE, 'utf-8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      data = { ...structuredClone(EMPTY), ...parsed }
      for (const key of ['users', 'packs', 'assets', 'sessions', 'apiKeys']) {
        if (!Array.isArray(data[key])) data[key] = []
      }
    } catch {
      // A corrupt database is kept aside rather than silently replaced: the .glb files it
      // describes are still on disk and someone may want to recover the metadata.
      const backup = DB_FILE + '.corrupt-' + Date.now()
      try {
        renameSync(DB_FILE, backup)
        console.error(`[db] ${DB_FILE} was unreadable; moved to ${backup} and started empty.`)
      } catch {
        console.error(`[db] ${DB_FILE} was unreadable and could not be moved aside.`)
      }
      data = structuredClone(EMPTY)
    }
  } else {
    data = structuredClone(EMPTY)
  }
  return data
}

export function db() {
  return load()
}

function writeNow() {
  ensureDirs()
  const tmp = DB_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf-8')
  renameSync(tmp, DB_FILE)
}

// Bursts of writes (a 40-asset upload) collapse into one flush; anything urgent can force
// it. The process also flushes on exit so a debounced write is never lost.
export function save({ immediate = false } = {}) {
  if (immediate) {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    writeNow()
    return
  }
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      writeNow()
    } catch (e) {
      console.error('[db] write failed:', e.message)
    }
  }, 120)
  writeTimer.unref?.()
}

export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    writeNow()
  } catch (e) {
    console.error('[db] final write failed:', e.message)
  }
}

export function id() {
  return randomUUID().replace(/-/g, '').slice(0, 20)
}

export const now = () => new Date().toISOString()
