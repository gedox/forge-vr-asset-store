// Dark / light theme toggle, shared by every page.
// Loaded as a plain script in <head> so the theme is set before first paint (no flash),
// then it injects a toggle button into the masthead once the DOM is ready.
(function () {
  var STORAGE = 'forge-theme'
  var root = document.documentElement

  function systemPref() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function current() {
    try {
      var saved = localStorage.getItem(STORAGE)
      if (saved === 'dark' || saved === 'light') return saved
    } catch (e) {}
    return systemPref()
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme)
    var btn = document.getElementById('theme-toggle')
    if (btn) btn.setAttribute('aria-pressed', theme === 'dark')
  }

  function build() {
    var bar = document.querySelector('.masthead .bar')
    if (!bar || document.getElementById('theme-toggle')) return
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'theme-toggle'
    btn.className = 'theme-toggle'
    btn.setAttribute('aria-pressed', root.getAttribute('data-theme') === 'dark')
    btn.setAttribute('aria-label', 'Toggle dark theme')
    btn.setAttribute('title', 'Toggle dark theme')
    btn.innerHTML =
      '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12.6A8 8 0 1 1 11.4 4a6.5 6.5 0 0 0 8.6 8.6z"/></svg>' +
      '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></svg>'
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      apply(next)
      try {
        localStorage.setItem(STORAGE, next)
      } catch (e) {}
    })
    bar.appendChild(btn)
  }

  apply(current())
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
  else build()
})()
