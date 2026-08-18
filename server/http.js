// Small helpers over node:http — enough routing, body handling and static serving for a
// store this size, without a framework in the way.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

export function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

export function noContent(res) {
  res.writeHead(204)
  res.end()
}

export function redirect(res, location) {
  res.writeHead(302, { location })
  res.end()
}

// Thrown by handlers; the router turns it into a JSON error with the right status.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const badRequest = (m) => new HttpError(400, m)
export const unauthorized = (m = 'Sign in first.') => new HttpError(401, m)
export const forbidden = (m = 'That is not yours.') => new HttpError(403, m)
export const notFound = (m = 'Not found.') => new HttpError(404, m)
export const conflict = (m) => new HttpError(409, m)
export const tooLarge = (m) => new HttpError(413, m)

// Collect a request body, refusing anything past the limit before it is buffered whole.
export function readBody(req, limitBytes) {
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

export async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf-8'))
  } catch {
    throw badRequest('Body was not valid JSON.')
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`]
  if (httpOnly) parts.push('HttpOnly')
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`)
  const existing = res.getHeader('set-cookie')
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : []
  res.setHeader('set-cookie', [...list, parts.join('; ')])
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

export function mimeFor(path) {
  return MIME[extname(path).toLowerCase()] || 'application/octet-stream'
}

// Serve a file from under `root`, refusing anything that escapes it.
export function sendFile(res, root, relPath, { download = null, immutable = false } = {}) {
  const clean = normalize(relPath).replace(/^(\.\.[/\\])+/, '')
  const full = join(root, clean)
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep) && full !== root) {
    throw forbidden('Path escapes the served directory.')
  }
  if (!existsSync(full) || !statSync(full).isFile()) throw notFound()
  const stat = statSync(full)
  const headers = {
    'content-type': mimeFor(full),
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  }
  if (download) headers['content-disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`
  res.writeHead(200, headers)
  createReadStream(full).pipe(res)
}

// A tiny path-pattern matcher: '/api/packs/:id/assets' → { id }.
export function match(pattern, pathname) {
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

// Metadata travels in headers on raw uploads, so it arrives percent-encoded.
export function headerText(req, name, fallback = '') {
  const raw = req.headers[name]
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
