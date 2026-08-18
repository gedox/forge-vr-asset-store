// The catalogue: section index, search, and the pack listing.
//
// The newest pack is set as a lead plate and the rest run as catalogue rows, so the page
// opens on an object instead of on a wall of equal cards.

import { api } from './api.js'
import { bytes, count, cubeMark, el, markNav, mosaic, mountAccount, sectionLabel, when } from './ui.js'

const results = document.getElementById('results')
const sections = document.getElementById('sections')
const searchInput = document.getElementById('q')
const sortSelect = document.getElementById('sort')

const state = {
  section: new URLSearchParams(location.search).get('section') || 'all',
  q: new URLSearchParams(location.search).get('q') || '',
  sort: 'newest'
}

markNav()
mountAccount(document.getElementById('account'))
searchInput.value = state.q

function packHref(pack) {
  return `/pack.html?id=${encodeURIComponent(pack.slug || pack.id)}`
}

function renderSections(counts) {
  const entries = [['all', 'All'], ['props', 'Props'], ['characters', 'Characters'], ['custom', 'Custom']]
  sections.replaceChildren(
    ...entries.map(([id, label]) =>
      el(
        'a',
        {
          href: `/index.html?section=${id}`,
          'aria-current': state.section === id ? 'true' : null,
          onclick: (e) => {
            e.preventDefault()
            state.section = id
            history.replaceState(null, '', id === 'all' ? '/index.html' : `/index.html?section=${id}`)
            load()
          }
        },
        label,
        el('span', { class: 'n num' }, counts?.[id] ?? 0)
      )
    )
  )
}

function lead(pack) {
  return el(
    'a',
    { class: 'lead', href: packHref(pack) },
    mosaic(pack, 5),
    el(
      'div',
      {},
      el('div', { class: 'kicker' }, 'Latest'),
      el('h2', {}, cubeMark(), pack.name),
      el('p', {}, pack.description || `${count(pack.assetCount, 'asset')} in ${sectionLabel(pack.section).toLowerCase()}.`),
      el(
        'div',
        { class: 'facts', style: 'text-align:left;justify-items:start' },
        el('span', { class: 'num' }, el('b', {}, String(pack.assetCount)), ' assets · ', bytes(pack.totalBytes)),
        el('span', {}, pack.owner ? `by ${pack.owner.displayName}` : ''),
        el('span', { class: 'num' }, `updated ${when(pack.updatedAt)}`)
      )
    )
  )
}

function plate(pack, index) {
  return el(
    'a',
    { class: 'plate', href: packHref(pack) },
    el('div', { class: 'index num' }, String(index).padStart(2, '0')),
    mosaic(pack, 6),
    el(
      'div',
      { class: 'body' },
      el('div', { class: 'title' }, cubeMark(), pack.name),
      el('p', { class: 'blurb' }, pack.description || ''),
      el('div', { class: 'by' }, pack.owner ? pack.owner.displayName : '')
    ),
    el(
      'div',
      { class: 'facts' },
      el('span', { class: 'sect' }, sectionLabel(pack.section)),
      el('span', { class: 'num' }, el('b', {}, String(pack.assetCount)), ' assets'),
      el('span', { class: 'num' }, bytes(pack.totalBytes)),
      el('span', { class: 'num' }, when(pack.updatedAt))
    )
  )
}

function emptyNote() {
  const filtered = state.q || state.section !== 'all'
  return el(
    'div',
    { class: 'empty-note' },
    el('h2', {}, filtered ? 'Nothing under that heading yet.' : 'The catalogue is empty.'),
    el(
      'p',
      {},
      filtered
        ? 'Try another section, or clear the search.'
        : 'Packs arrive two ways: published from the Forge VR Asset Generator over its Store tab, or uploaded by hand from your profile page.'
    ),
    !filtered ? el('p', {}, el('a', { href: '/profile.html' }, 'Start a pack →')) : null
  )
}

let inFlight = 0

async function load() {
  const run = ++inFlight
  results.setAttribute('aria-busy', 'true')
  try {
    const data = await api.packs({ section: state.section, q: state.q, sort: state.sort })
    if (run !== inFlight) return // a later keystroke already won
    renderSections(data.counts)
    if (!data.packs.length) {
      results.replaceChildren(emptyNote())
      return
    }
    const [first, ...rest] = data.packs
    const showLead = state.sort === 'newest' && !state.q && data.packs.length > 1
    results.replaceChildren(
      ...(showLead ? [lead(first)] : []),
      el('div', { class: 'plates' }, (showLead ? rest : data.packs).map((p, i) => plate(p, i + 1)))
    )
  } catch (e) {
    results.replaceChildren(el('p', { class: 'error' }, e.message))
  } finally {
    results.removeAttribute('aria-busy')
  }
}

let debounce
searchInput.addEventListener('input', () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => {
    state.q = searchInput.value.trim()
    load()
  }, 180)
})

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value
  load()
})

load()
