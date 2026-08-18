// Packs and the assets inside them.
//
// A pack belongs to exactly one user and holds .glb files. Two invariants matter enough to
// be enforced here rather than in the routes:
//   - a user cannot own two packs with the same name (the desktop app relies on this to
//     decide between "create a pack" and "add to the one I already have")
//   - only real .glb bytes are ever written to disk

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASSETS_DIR, MAX_ASSETS_PER_PACK, MAX_COVER_ASSETS, MAX_PACK_BYTES, SECTIONS, THUMBS_DIR } from './config.js'
import { db, id, now, save } from './db.js'
import { badRequest, conflict, forbidden, notFound, tooLarge } from './http.js'

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'pack'
}

function uniqueSlug(base) {
  const taken = new Set(db().packs.map((p) => p.slug))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

// The first 12 bytes of a .glb are the magic 'glTF', a version and the total length. A
// renamed .fbx, a .zip or an HTML error page all fail here.
export function assertGlb(buffer) {
  if (buffer.length < 20) throw badRequest('That file is too small to be a .glb.')
  if (buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw badRequest('That is not a .glb file — the glTF binary header is missing.')
  }
  const version = buffer.readUInt32LE(4)
  if (version !== 2) throw badRequest(`Only glTF 2.0 binaries are accepted (this one is version ${version}).`)
  const declared = buffer.readUInt32LE(8)
  if (declared !== buffer.length) {
    throw badRequest('The .glb header length does not match the file — it arrived truncated.')
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function assertPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw badRequest('Previews must be PNG images.')
  }
}

export function packsOf(userId) {
  return db().packs.filter((p) => p.userId === userId)
}

export function findPack(packIdOrSlug) {
  return db().packs.find((p) => p.id === packIdOrSlug || p.slug === packIdOrSlug) || null
}

export function assetsOf(packId) {
  return db().assets.filter((a) => a.packId === packId)
}

export function ownedPack(user, packIdOrSlug) {
  const pack = findPack(packIdOrSlug)
  if (!pack) throw notFound('No such pack.')
  if (pack.userId !== user.id) throw forbidden('That pack belongs to someone else.')
  return pack
}

export function nameTaken(userId, name, exceptPackId = null) {
  const target = String(name || '').trim().toLowerCase()
  return packsOf(userId).some((p) => p.id !== exceptPackId && p.name.trim().toLowerCase() === target)
}

export function createPack(user, { name, section, description }) {
  const clean = String(name || '').trim()
  if (!clean) throw badRequest('A pack needs a name.')
  if (clean.length > 80) throw badRequest('Pack names stop at 80 characters.')
  if (nameTaken(user.id, clean)) {
    throw conflict(`You already have a pack called "${clean}". Add to that one, or pick another name.`)
  }
  const sect = SECTIONS.includes(section) ? section : 'props'
  const pack = {
    id: id(),
    userId: user.id,
    name: clean,
    slug: uniqueSlug(slugify(clean)),
    section: sect,
    description: String(description || '').trim().slice(0, 600),
    coverAssetIds: [],
    createdAt: now(),
    updatedAt: now()
  }
  db().packs.push(pack)
  save({ immediate: true })
  return pack
}

export function updatePack(user, packIdOrSlug, patch) {
  const pack = ownedPack(user, packIdOrSlug)
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim()
    if (!clean) throw badRequest('A pack needs a name.')
    if (nameTaken(user.id, clean, pack.id)) {
      throw conflict(`You already have a pack called "${clean}".`)
    }
    pack.name = clean.slice(0, 80)
  }
  if (patch.section !== undefined) {
    if (!SECTIONS.includes(patch.section)) throw badRequest('Unknown section.')
    pack.section = patch.section
  }
  if (patch.description !== undefined) {
    pack.description = String(patch.description).trim().slice(0, 600)
  }
  if (patch.coverAssetIds !== undefined) {
    const owned = new Set(assetsOf(pack.id).map((a) => a.id))
    const covers = (Array.isArray(patch.coverAssetIds) ? patch.coverAssetIds : [])
      .filter((assetId) => owned.has(assetId))
      .slice(0, MAX_COVER_ASSETS)
    pack.coverAssetIds = covers
  }
  pack.updatedAt = now()
  save({ immediate: true })
  return pack
}

export function deletePack(user, packIdOrSlug) {
  const pack = ownedPack(user, packIdOrSlug)
  for (const asset of assetsOf(pack.id)) removeAssetFiles(asset)
  const store = db()
  store.assets = store.assets.filter((a) => a.packId !== pack.id)
  store.packs = store.packs.filter((p) => p.id !== pack.id)
  save({ immediate: true })
}

function removeAssetFiles(asset) {
  for (const path of [join(ASSETS_DIR, asset.id + '.glb'), join(THUMBS_DIR, asset.id + '.png')]) {
    try {
      if (existsSync(path)) rmSync(path)
    } catch {
      /* a stranded file is better than a failed delete */
    }
  }
}

export function packBytes(packId) {
  return assetsOf(packId).reduce((n, a) => n + a.sizeBytes, 0)
}

export function addAsset(user, packIdOrSlug, buffer, meta) {
  const pack = ownedPack(user, packIdOrSlug)
  assertGlb(buffer)

  const existing = assetsOf(pack.id)
  if (existing.length >= MAX_ASSETS_PER_PACK) {
    throw tooLarge(`A pack holds at most ${MAX_ASSETS_PER_PACK} assets.`)
  }
  if (packBytes(pack.id) + buffer.length > MAX_PACK_BYTES) {
    throw tooLarge(`That would push the pack past its ${(MAX_PACK_BYTES / 1048576).toFixed(0)} MB total.`)
  }

  const name = String(meta.name || '').trim().slice(0, 120) || 'untitled asset'
  const fileName = (String(meta.fileName || '').trim() || slugify(name) + '.glb').replace(/[^a-zA-Z0-9._-]/g, '_')

  // Re-publishing the same source asset replaces it in place rather than stacking
  // duplicates — the desktop app sends the library id it came from.
  const sourceId = String(meta.sourceId || '').trim()
  const previous = sourceId ? existing.find((a) => a.sourceId === sourceId) : null
  if (previous) {
    writeFileSync(join(ASSETS_DIR, previous.id + '.glb'), buffer)
    previous.name = name
    previous.fileName = fileName
    previous.sizeBytes = buffer.length
    previous.triangles = Number(meta.triangles) || previous.triangles || 0
    previous.category = meta.category || previous.category || 'prop'
    previous.updatedAt = now()
    pack.updatedAt = now()
    save({ immediate: true })
    return previous
  }

  const asset = {
    id: id(),
    packId: pack.id,
    userId: user.id,
    name,
    fileName,
    sizeBytes: buffer.length,
    triangles: Number(meta.triangles) || 0,
    category: meta.category || 'prop',
    sourceId,
    hasThumb: false,
    createdAt: now(),
    updatedAt: now()
  }
  writeFileSync(join(ASSETS_DIR, asset.id + '.glb'), buffer)
  db().assets.push(asset)

  // The first assets in become the pack's face until the creator chooses otherwise, so a
  // freshly uploaded pack is never a row of empty squares.
  if (pack.coverAssetIds.length < MAX_COVER_ASSETS) pack.coverAssetIds.push(asset.id)
  pack.updatedAt = now()
  save({ immediate: true })
  return asset
}

export function setAssetThumb(user, packIdOrSlug, assetId, buffer) {
  const pack = ownedPack(user, packIdOrSlug)
  assertPng(buffer)
  const asset = assetsOf(pack.id).find((a) => a.id === assetId)
  if (!asset) throw notFound('No such asset in that pack.')
  writeFileSync(join(THUMBS_DIR, asset.id + '.png'), buffer)
  asset.hasThumb = true
  asset.updatedAt = now()
  pack.updatedAt = now()
  save({ immediate: true })
  return asset
}

export function removeAsset(user, packIdOrSlug, assetId) {
  const pack = ownedPack(user, packIdOrSlug)
  const asset = assetsOf(pack.id).find((a) => a.id === assetId)
  if (!asset) throw notFound('No such asset in that pack.')
  removeAssetFiles(asset)
  const store = db()
  store.assets = store.assets.filter((a) => a.id !== asset.id)
  pack.coverAssetIds = pack.coverAssetIds.filter((cover) => cover !== asset.id)
  // Keep the face populated as assets come and go.
  if (pack.coverAssetIds.length === 0) {
    pack.coverAssetIds = assetsOf(pack.id).slice(0, MAX_COVER_ASSETS).map((a) => a.id)
  }
  pack.updatedAt = now()
  save({ immediate: true })
}

// --- shaping for the wire ----------------------------------------------------
export function publicAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    fileName: asset.fileName,
    sizeBytes: asset.sizeBytes,
    triangles: asset.triangles || undefined,
    category: asset.category,
    thumbUrl: asset.hasThumb ? `/files/thumbs/${asset.id}.png` : undefined,
    fileUrl: `/files/assets/${asset.id}.glb`
  }
}

export function publicPack(pack, { withAssets = true } = {}) {
  const assets = assetsOf(pack.id)
  const owner = db().users.find((u) => u.id === pack.userId)
  const covers = pack.coverAssetIds.filter((assetId) => assets.some((a) => a.id === assetId))
  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    section: pack.section,
    description: pack.description,
    assetCount: assets.length,
    totalBytes: assets.reduce((n, a) => n + a.sizeBytes, 0),
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
    coverAssetIds: covers.length ? covers : assets.slice(0, MAX_COVER_ASSETS).map((a) => a.id),
    owner: owner ? { id: owner.id, displayName: owner.displayName, avatarUrl: owner.avatarUrl || undefined } : null,
    assets: withAssets ? assets.map(publicAsset) : undefined
  }
}
