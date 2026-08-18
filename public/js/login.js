import { api } from './api.js'
import { el, setError } from './ui.js'

const form = document.getElementById('form')
const msg = document.getElementById('msg')
const submit = document.getElementById('submit')
const nameField = document.getElementById('name-field')
const tabIn = document.getElementById('tab-in')
const tabNew = document.getElementById('tab-new')

let mode = new URLSearchParams(location.search).get('new') ? 'register' : 'login'

function paint() {
  const registering = mode === 'register'
  tabIn.setAttribute('aria-selected', String(!registering))
  tabNew.setAttribute('aria-selected', String(registering))
  nameField.hidden = !registering
  submit.textContent = registering ? 'Create account' : 'Sign in'
  form.password.autocomplete = registering ? 'new-password' : 'current-password'
  setError(msg, null)
}

tabIn.addEventListener('click', () => {
  mode = 'login'
  paint()
})
tabNew.addEventListener('click', () => {
  mode = 'register'
  paint()
})
paint()

// Google's button is only offered when the server actually has credentials for it —
// showing a button that lands on an error page is worse than not showing it.
api.config().then((config) => {
  document.getElementById('google-block').hidden = !config.googleEnabled
  document.getElementById('google-note').hidden = config.googleEnabled
})

// Already signed in? Nothing to do here.
api.me().then(() => location.replace('/profile.html')).catch(() => {})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  submit.disabled = true
  setError(msg, null)
  const body = {
    email: form.email.value.trim(),
    password: form.password.value,
    displayName: form.displayName?.value?.trim()
  }
  try {
    if (mode === 'register') await api.register(body)
    else await api.login(body)
    location.href = '/profile.html'
  } catch (err) {
    setError(msg, err.message)
    submit.disabled = false
  }
})

// A first-timer landing on the sign-in tab with an unknown email gets nudged rather than
// left guessing why it failed.
form.email.addEventListener('input', () => {
  if (msg.textContent.includes('wrong')) {
    msg.replaceChildren(el('p', { class: 'note' }, 'No account yet? Use “Create account”.'))
  }
})
