// The creator's side: every pack you own, editable where you see it.
//
// Editing is direct — click a tile to promote it onto the pack's front page, click × to
// drop the asset, drag .glb files onto the pack to add more. Nothing opens a modal.

import { api } from './api.js'
import { bytes, count, el, markNav, mountAccount, sectionLabel, setError, when } from './ui.js'

const main = document.getElementById('main')
markNav()

let user = null
let config = { limits: { maxAssetBytes: 25 * 1048576, maxCoverAssets: 7 } }

function signedOut() {
  main.replaceChildren(
    el(
      'div',
      { class: 'empty-note' },
      el('h2', {}, 'Sign in to see your packs.'),
      el('p', {}, 'Your packs, the assets in them, and the API key the Forge desktop app publishes with all live behind your account.'),
      el('p', {}, el('a', { class: 'btn primary', href: '/login.html' }, 'Sign in'), ' ', el('a', { class: 'btn', href: '/login.html?new=1' }, 'Create account'))
    )
  )
}

// --- pack editor -------------------------------------------------------------
function packEditor(pack, reload) {
  const status = el('div', {})
  const tiles = el('div', { class: 'tile-grid' })

  const paintTiles = () => {
    const covers = new Set(pack.coverAssetIds || [])
    tiles.replaceChildren(
      ...(pack.assets || []).map((asset) =>
        el(
          'div',
          { class: 'tile' + (covers.has(asset.id) ? ' cover' : '') },
          asset.thumbUrl ? el('img', { src: asset.thumbUrl, alt: asset.name, loading: 'lazy' }) : el('div', { class: 'none' }, 'no preview'),
          el('div', { class: 'nm', title: asset.name }, asset.name),
          el(
            'button',
            {
              class: 'mark',
              title: covers.has(asset.id) ? 'Showing on the pack front' : `Show on the pack front (up to ${config.limits.maxCoverAssets})`,
              onclick: () => toggleCover(asset)
            },
            covers.has(asset.id) ? '★ front' : '☆ front'
          ),
          el(
            'button',
            {
              class: 'kill',
              title: 'Remove this asset from the pack',
              onclick: () => dropAsset(asset)
            },
            '×'
          )
        )
      ),
      ...((pack.assets || []).length ? [] : [el('p', { class: 'note' }, 'This pack is empty. Add .glb files below, or publish into it from Forge.')])
    )
  }

  async function toggleCover(asset) {
    const covers = new Set(pack.coverAssetIds || [])
    if (covers.has(asset.id)) covers.delete(asset.id)
    else {
      if (covers.size >= config.limits.maxCoverAssets) {
        setError(status, `A pack shows at most ${config.limits.maxCoverAssets} assets on its front. Drop one first.`)
        return
      }
      covers.add(asset.id)
    }
    setError(status, null)
    pack.coverAssetIds = [...covers]
    paintTiles()
    try {
      const r = await api.updatePack(pack.id, { coverAssetIds: pack.coverAssetIds })
      pack.coverAssetIds = r.pack.coverAssetIds
      paintTiles()
    } catch (e) {
      setError(status, e.message)
    }
  }

  async function dropAsset(asset) {
    if (!confirm(`Remove "${asset.name}" from ${pack.name}? The file is deleted from the store.`)) return
    try {
      await api.removeAsset(pack.id, asset.id)
      reload()
    } catch (e) {
      setError(status, e.message)
    }
  }

  paintTiles()

  // --- details form ---
  const nameInput = el('input', { type: 'text', value: pack.name })
  const sectionSelect = el(
    'select',
    {},
    ...['props', 'characters', 'custom'].map((s) => el('option', { value: s, selected: pack.section === s || null }, sectionLabel(s)))
  )
  const descInput = el('textarea', {}, pack.description || '')
  const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Save details')

  const details = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault()
        saveBtn.disabled = true
        setError(status, null)
        try {
          await api.updatePack(pack.id, {
            name: nameInput.value.trim(),
            section: sectionSelect.value,
            description: descInput.value.trim()
          })
          reload()
        } catch (err) {
          setError(status, err.message)
          saveBtn.disabled = false
        }
      }
    },
    el('label', { class: 'field' }, el('span', {}, 'Pack name'), nameInput),
    el('label', { class: 'field' }, el('span', {}, 'Section'), sectionSelect),
    el('label', { class: 'field' }, el('span', {}, 'Description'), descInput),
    el(
      'div',
      { style: 'display:flex;gap:.6rem;flex-wrap:wrap' },
      saveBtn,
      el('a', { class: 'btn', href: `/pack.html?id=${pack.slug}` }, 'View page'),
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: async () => {
            if (!confirm(`Delete "${pack.name}" and all ${pack.assetCount} assets in it? This cannot be undone.`)) return
            try {
              await api.deletePack(pack.id)
              reload()
            } catch (err) {
              setError(status, err.message)
            }
          }
        },
        'Delete pack'
      )
    )
  )

  // --- uploader ---
  const progress = el('i', { style: 'width:0%' })
  const progressBar = el('div', { class: 'bar-progress', hidden: true }, progress)
  const fileInput = el('input', { type: 'file', accept: '.glb,model/gltf-binary', multiple: true })
  const zone = el(
    'div',
    { class: 'dropzone' },
    el('span', {}, 'Drop .glb files here, or '),
    el('b', { onclick: () => fileInput.click() }, 'choose files'),
    el('span', {}, ` — up to ${(config.limits.maxAssetBytes / 1048576).toFixed(0)} MB each.`),
    fileInput,
    progressBar
  )

  async function upload(files) {
    const list = [...files].filter((f) => /\.glb$/i.test(f.name))
    const rejected = [...files].length - list.length
    if (!list.length) {
      setError(status, rejected ? 'Only .glb files can go into a pack.' : 'No files chosen.')
      return
    }
    setError(status, null)
    progressBar.hidden = false
    let done = 0
    const failures = []
    for (const file of list) {
      if (file.size > config.limits.maxAssetBytes) {
        failures.push(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB`)
        continue
      }
      try {
        await api.uploadAsset(pack.id, file)
      } catch (e) {
        failures.push(`${file.name}: ${e.message}`)
      }
      done++
      progress.style.width = `${(done / list.length) * 100}%`
    }
    progressBar.hidden = true
    progress.style.width = '0%'
    if (failures.length) setError(status, `Not everything went up — ${failures.join('; ')}`)
    reload({ keepOpen: pack.id })
  }

  fileInput.addEventListener('change', () => upload(fileInput.files))
  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('hot')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('hot'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('hot')
    upload(e.dataTransfer.files)
  })

  const node = el(
    'details',
    { class: 'pack-editor', 'data-id': pack.id },
    el(
      'summary',
      {},
      el('div', {}, el('h2', {}, pack.name), el('div', { class: 'note' }, pack.description || 'No description yet')),
      el(
        'div',
        { class: 'facts' },
        el('span', { class: 'sect' }, sectionLabel(pack.section)),
        el('span', { class: 'num' }, count(pack.assetCount, 'asset')),
        el('span', { class: 'num' }, `${bytes(pack.totalBytes)} · ${when(pack.updatedAt)}`)
      ),
      el('span', { class: 'chev' }, '▶')
    ),
    el(
      'div',
      { class: 'editor-body' },
      el('div', {}, el('h3', {}, 'Details'), details, status),
      el(
        'div',
        {},
        el('h3', {}, 'Contents'),
        el('p', { class: 'note' }, 'Starred assets are the ones shown on the pack’s front page.'),
        tiles,
        zone
      )
    )
  )
  return node
}

// --- new pack ----------------------------------------------------------------
function newPackForm(reload) {
  const name = el('input', { type: 'text', placeholder: 'Derelict Station Kit', required: true })
  const section = el('select', {}, ...['props', 'characters', 'custom'].map((s) => el('option', { value: s }, sectionLabel(s))))
  const status = el('div', {})
  return el(
    'form',
    {
      class: 'pack-editor',
      style: 'display:grid;grid-template-columns:minmax(0,1fr) 12rem auto;gap:1rem;align-items:end',
      onsubmit: async (e) => {
        e.preventDefault()
        try {
          await api.createPack({ name: name.value.trim(), section: section.value })
          name.value = ''
          reload()
        } catch (err) {
          setError(status, err.message)
        }
      }
    },
    el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Start a pack'), name),
    el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Section'), section),
    el('button', { class: 'btn', type: 'submit' }, 'Create'),
    el('div', { style: 'grid-column:1/-1' }, status)
  )
}

// --- API keys ----------------------------------------------------------------
function keysPanel() {
  const rows = el('div', {})
  const reveal = el('div', {})

  async function paint() {
    const { keys } = await api.keys()
    rows.replaceChildren(
      ...(keys.length
        ? keys.map((key) =>
            el(
              'div',
              { class: 'key-row' },
              el('span', {}, key.label),
              el('span', { class: 'hint' }, `${key.hint}…`),
              el('span', { class: 'when num' }, `made ${when(key.createdAt)}${key.lastUsedAt ? ` · used ${when(key.lastUsedAt)}` : ' · never used'}`),
              el(
                'button',
                {
                  class: 'btn small danger',
                  onclick: async () => {
                    if (!confirm(`Revoke "${key.label}"? Any Forge install using it stops publishing.`)) return
                    await api.deleteKey(key.id)
                    paint()
                  }
                },
                'Revoke'
              )
            )
          )
        : [el('p', { class: 'note' }, 'No keys yet. Make one, then paste it into Forge → Store.')])
    )
  }

  const label = el('input', { type: 'text', placeholder: 'Forge on this machine' })
  paint()

  return el(
    'section',
    { class: 'keys' },
    el('h2', {}, 'Publishing keys'),
    el('p', { class: 'note' }, 'The Forge VR Asset Generator signs in with one of these instead of a password. A key is shown once, at creation.'),
    reveal,
    rows,
    el(
      'div',
      { style: 'display:flex;gap:.6rem;margin-top:1rem;max-width:32rem' },
      label,
      el(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const r = await api.createKey(label.value.trim())
            label.value = ''
            reveal.replaceChildren(
              el(
                'div',
                { class: 'key-reveal' },
                el('div', {}, 'Copy this into Forge → Store now. It will not be shown again.'),
                el('code', {}, r.key)
              )
            )
            paint()
          }
        },
        'New key'
      )
    )
  )
}

// --- page --------------------------------------------------------------------
async function load({ keepOpen = null } = {}) {
  const open = keepOpen
    ? [keepOpen]
    : [...document.querySelectorAll('.pack-editor[open]')].map((n) => n.dataset.id).filter(Boolean)
  const { packs } = await api.myPacks()
  const total = packs.reduce((n, p) => n + p.assetCount, 0)

  main.replaceChildren(
    el(
      'div',
      { class: 'profile-head' },
      el('div', {}, el('h1', {}, 'My packs'), el('div', { class: 'who num' }, `${count(packs.length, 'pack')} · ${count(total, 'asset')}`)),
      el('a', { class: 'btn', href: '/index.html' }, 'See the catalogue')
    ),
    newPackForm(load),
    ...packs.map((pack) => {
      const node = packEditor(pack, load)
      if (open.includes(pack.id)) node.setAttribute('open', '')
      return node
    }),
    packs.length ? null : el('p', { class: 'note', style: 'padding-block:1.5rem' }, 'Nothing published yet — start a pack above, or send one up from Forge’s Store tab.'),
    keysPanel()
  )
}

async function start() {
  config = await api.config().catch(() => config)
  user = await mountAccount(document.getElementById('account'))
  if (!user) {
    signedOut()
    return
  }
  try {
    await load()
  } catch (e) {
    main.replaceChildren(el('p', { class: 'error' }, e.message))
  }
}

start()
