// One pack: a viewport with whichever asset is selected, the pack's facts beside it, and
// the full contents underneath.

import { api } from './api.js'
import { bytes, count, el, markNav, mountAccount, sectionLabel, when } from './ui.js'

const main = document.getElementById('main')
markNav()
mountAccount(document.getElementById('account'))

const id = new URLSearchParams(location.search).get('id')

function specRow(label, value) {
  return el('tr', {}, el('th', {}, label), el('td', { class: 'num' }, value))
}

async function render() {
  if (!id) {
    main.replaceChildren(el('p', { class: 'error' }, 'No pack was named in the address.'))
    return
  }
  let pack
  try {
    pack = (await api.pack(id)).pack
  } catch (e) {
    main.replaceChildren(
      el('div', { class: 'empty-note' }, el('h2', {}, 'That pack is not here.'), el('p', {}, e.message), el('p', {}, el('a', { href: '/' }, '← Back to the catalogue')))
    )
    return
  }

  document.title = `${pack.name} — Forge VR Asset Store`
  const assets = pack.assets || []
  const canvas = el('canvas')
  const nowLabel = el('div', { class: 'now' }, assets[0]?.name || '—')

  const list = el('div', { class: 'asset-list' })
  let viewer = null
  let currentId = null

  async function select(asset) {
    if (!asset || asset.id === currentId) return
    currentId = asset.id
    nowLabel.textContent = asset.name
    for (const tile of list.querySelectorAll('.asset-tile')) {
      tile.setAttribute('aria-current', tile.dataset.id === asset.id ? 'true' : 'false')
    }
    try {
      if (!viewer) {
        const { createViewer } = await import('./viewer.js')
        viewer = createViewer(canvas)
      }
      await viewer.show(asset.fileUrl)
    } catch (e) {
      nowLabel.textContent = `${asset.name} — preview failed`
      console.error(e)
    }
  }

  list.replaceChildren(
    ...assets.map((asset) =>
      el(
        'button',
        { class: 'asset-tile', 'data-id': asset.id, 'aria-current': 'false', onclick: () => select(asset) },
        el(
          'div',
          { class: 'shot' },
          asset.thumbUrl ? el('img', { src: asset.thumbUrl, alt: asset.name, loading: 'lazy' }) : el('span', { class: 'none' }, 'no preview')
        ),
        el('div', { class: 'nm' }, asset.name),
        el('div', { class: 'sz num' }, `${bytes(asset.sizeBytes)}${asset.triangles ? ` · ${asset.triangles.toLocaleString()} tris` : ''}`)
      )
    )
  )

  main.replaceChildren(
    el(
      'div',
      { class: 'pack-grid' },
      el(
        'div',
        { class: 'viewer' },
        canvas,
        nowLabel,
        el('div', { class: 'hint' }, assets.length ? 'drag to turn · scroll to zoom' : 'this pack has no assets yet')
      ),
      el(
        'div',
        { class: 'pack-side' },
        el('div', { class: 'sect' }, sectionLabel(pack.section)),
        el('h1', {}, pack.name),
        el('p', { class: 'desc' }, pack.description || 'No description given.'),
        el(
          'table',
          { class: 'spec' },
          el(
            'tbody',
            {},
            specRow('Assets', String(pack.assetCount)),
            specRow('Total size', bytes(pack.totalBytes)),
            specRow('Format', 'glTF binary (.glb)'),
            specRow('Published by', pack.owner?.displayName || '—'),
            specRow('Updated', when(pack.updatedAt))
          )
        ),
        assets.length
          ? el('a', { class: 'btn primary', href: `/api/packs/${encodeURIComponent(pack.id)}/download` }, `Download pack · ${bytes(pack.totalBytes)}`)
          : null
      )
    ),
    el(
      'section',
      { class: 'asset-strip' },
      el('h2', {}, count(assets.length, 'asset', 'assets') + ' in this pack'),
      assets.length ? list : el('p', { class: 'note' }, 'Nothing uploaded into it yet.')
    )
  )

  document.getElementById('foot-note').textContent = `${pack.name} · ${count(assets.length, 'asset')}`
  if (assets.length) select(assets[0])
}

render()
