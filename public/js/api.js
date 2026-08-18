// Thin wrapper over the store's JSON API. Every call is same-origin and carries the
// session cookie; errors arrive as { error } and are re-thrown with that message so the
// pages never have to unwrap a Response.

async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: raw ? headers : { 'content-type': 'application/json', ...headers },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 204) return null
  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status}).`)
    err.status = res.status
    throw err
  }
  return payload
}

export const api = {
  config: () => call('/api/config'),
  me: () => call('/api/me'),
  register: (body) => call('/api/auth/register', { method: 'POST', body }),
  login: (body) => call('/api/auth/login', { method: 'POST', body }),
  logout: () => call('/api/auth/logout', { method: 'POST' }),

  packs: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return call('/api/packs' + (q.toString() ? '?' + q : ''))
  },
  pack: (id) => call(`/api/packs/${encodeURIComponent(id)}`),
  myPacks: () => call('/api/me/packs'),
  createPack: (body) => call('/api/packs', { method: 'POST', body }),
  updatePack: (id, body) => call(`/api/packs/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deletePack: (id) => call(`/api/packs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // The .glb is the whole body; its metadata rides in headers, same shape the desktop app
  // uses, so there is exactly one upload path on the server.
  uploadAsset: (packId, file, meta = {}) =>
    call(`/api/packs/${encodeURIComponent(packId)}/assets`, {
      method: 'POST',
      raw: true,
      body: file,
      headers: {
        'content-type': 'model/gltf-binary',
        'x-asset-name': encodeURIComponent(meta.name || file.name.replace(/\.glb$/i, '')),
        'x-asset-filename': encodeURIComponent(meta.fileName || file.name),
        'x-asset-category': encodeURIComponent(meta.category || 'prop')
      }
    }),
  removeAsset: (packId, assetId) =>
    call(`/api/packs/${encodeURIComponent(packId)}/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }),

  keys: () => call('/api/keys'),
  createKey: (label) => call('/api/keys', { method: 'POST', body: { label } }),
  deleteKey: (id) => call(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
