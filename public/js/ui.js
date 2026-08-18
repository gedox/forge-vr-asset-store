// Shared bits every page needs: formatting, the masthead's account line, and a couple of
// DOM helpers. No framework — the pages are small enough to build their own markup.

import { api } from './api.js'

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'html') node.innerHTML = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

export function bytes(n) {
  if (!n) return '0 KB'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export function count(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}

export function when(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function sectionLabel(id) {
  return { props: 'Props', characters: 'Characters', custom: 'Custom' }[id] || id
}

// Fills the account slot in the masthead: who you are, or the way in.
export async function mountAccount(node) {
  if (!node) return null
  try {
    const { user } = await api.me()
    node.replaceChildren(
      el('a', { href: '/profile.html' }, user.displayName),
      el(
        'button',
        {
          class: 'btn quiet small',
          onclick: async () => {
            await api.logout()
            location.href = '/'
          }
        },
        'Sign out'
      )
    )
    return user
  } catch {
    node.replaceChildren(el('a', { href: '/login.html' }, 'Sign in'), el('a', { href: '/login.html?new=1' }, 'Create account'))
    return null
  }
}

export function markNav() {
  const path = location.pathname === '/' ? '/index.html' : location.pathname
  for (const link of document.querySelectorAll('.masthead nav a')) {
    if (new URL(link.href).pathname === path) link.setAttribute('aria-current', 'page')
  }
}

// A small wireframe-cube mark that sits beside a pack's name on the catalogue. It is the
// store's only "logo" and echoes the .glb the pack actually contains.
const CUBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 3 20 7v9l-8 5-8-5V7z"/><path d="M4 7l8 4 8-4"/><path d="M12 11v9"/></svg>'

export function cubeMark() {
  return el('span', { class: 'cube-mark', html: CUBE_SVG })
}

// A pack's chosen previews, in order, padded out to `slots` so a mosaic keeps its shape.
export function coverTiles(pack, slots) {
  const byId = new Map((pack.assets || []).map((a) => [a.id, a]))
  const chosen = (pack.coverAssetIds || []).map((id) => byId.get(id)).filter(Boolean)
  const rest = (pack.assets || []).filter((a) => !(pack.coverAssetIds || []).includes(a.id))
  const list = [...chosen, ...rest].slice(0, slots)
  return Array.from({ length: slots }, (_, i) => list[i] || null)
}

export function mosaic(pack, slots, className = 'mosaic') {
  return el(
    'div',
    { class: className },
    coverTiles(pack, slots).map((asset) =>
      el('div', { class: 'cell' }, asset?.thumbUrl ? el('img', { src: asset.thumbUrl, alt: asset.name, loading: 'lazy' }) : null)
    )
  )
}

export function setError(node, message) {
  if (!node) return
  node.replaceChildren()
  if (message) node.append(el('p', { class: 'error' }, message))
}
