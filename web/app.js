// Minimal Chat — frontend. Plain ES modules, no build step.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm'
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.0.13/lib/marked.esm.js'
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.15/dist/purify.es.mjs'
import * as config from './config.js'

window.chatReady = true

// ── Config ───────────────────────────────────────────────────────────────────

const APP_NAME = config.APP_NAME || 'Chat'
const MODELS = Array.isArray(config.MODELS) && config.MODELS.length
  ? config.MODELS
  : [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }]
const SUPABASE_URL = String(config.SUPABASE_URL ?? '').replace(/\/+$/, '')
const SUPABASE_KEY = String(config.SUPABASE_PUBLISHABLE_KEY ?? '')
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat`
const ALLOW_SIGN_UP = config.ALLOW_SIGN_UP !== false
const CONVERSATION_FIELDS = 'id, title, model, system_prompt, updated_at'
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches

const $ = (id) => document.getElementById(id)
const ui = {
  setup: $('setup'), auth: $('auth'), app: $('app'), loadError: $('load-error'),
  authForm: $('auth-form'), authTitle: $('auth-title'), authSubtitle: $('auth-subtitle'),
  authEmail: $('auth-email'), authPassword: $('auth-password'), authMessage: $('auth-message'),
  authSubmit: $('auth-submit'), authToggle: $('auth-toggle'),
  chatList: $('chat-list'), newChat: $('new-chat'), topbarNew: $('topbar-new'), menuBtn: $('menu-btn'), scrim: $('scrim'),
  account: $('account-btn'), avatar: $('avatar'), accountEmail: $('account-email'),
  main: $('main'), title: $('chat-title'), messages: $('messages'), thread: $('thread'),
  composer: $('composer'), input: $('input'), model: $('model'), send: $('send'), instructionsBtn: $('instructions-btn'),
  instructionsDialog: $('instructions-dialog'), instructionsText: $('instructions-text'),
  settingsDialog: $('settings-dialog'), customInstructions: $('custom-instructions'),
  settingsEmail: $('settings-email'), signOut: $('sign-out'),
  toast: $('toast'), srStatus: $('sr-status'),
}

document.title = APP_NAME
document.querySelectorAll('[data-app-name]').forEach((el) => (el.textContent = APP_NAME))
document.documentElement.classList.toggle('touch', IS_TOUCH)

const configured = /^https?:\/\//.test(SUPABASE_URL) && !SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  SUPABASE_KEY.length > 20 && !SUPABASE_KEY.endsWith('...')

// Per-browser convenience only (remembers your last model); the app works without it.
const store = {
  get: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch { /* storage unavailable */ }
  },
}

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  user: null,
  conversations: [], // newest first
  current: null, // the chat on screen, or null for a new chat
  messages: [], // messages of the chat on screen
  draftInstructions: '', // instructions for a chat that doesn't exist yet
  customInstructions: '',
  stream: null, // { controller, messages, reply, el, conversationId, instructions }
  loadSeq: 0,
}

// ── Markdown (sanitized: model output never runs as code) ────────────────────

marked.use({ gfm: true, breaks: true })
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})
const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
}

function renderMarkdown(target, text) {
  // Parse into an inert <template> first so nothing loads before we've checked it.
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(marked.parse(text), SANITIZE)
  // Images become links: a reply can't make your browser fetch URLs on its own.
  template.content.querySelectorAll('img').forEach((img) => {
    const link = el('a', '', `Image: ${img.getAttribute('alt') || img.getAttribute('src')}`)
    link.href = img.getAttribute('src') ?? '#'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    img.replaceWith(link)
  })
  template.content.querySelectorAll('pre').forEach(decorateCodeBlock)
  target.replaceChildren(template.content)
}

function decorateCodeBlock(pre) {
  const code = pre.querySelector('code')
  const lang = code?.className.match(/language-([\w#+.-]+)/)?.[1] ?? ''
  const copy = el('button', 'code-copy', 'Copy')
  copy.type = 'button'
  copy.addEventListener('click', () => copyText((code ?? pre).textContent, copy))
  const bar = el('div', 'code-bar')
  bar.append(el('span', '', lang || 'code'), copy)
  const block = el('div', 'code-block')
  pre.replaceWith(block)
  block.append(bar, pre)
}

// ── Session ──────────────────────────────────────────────────────────────────

const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

async function onSession(session) {
  if (!session) {
    if (state.user || ui.auth.hidden) {
      resetState()
      show('auth')
    }
    return
  }
  if (state.user?.id === session.user.id) return // token refresh etc.
  state.user = session.user
  ui.accountEmail.textContent = session.user.email ?? ''
  ui.avatar.textContent = (session.user.email ?? '?').charAt(0)
  show('app')
  await Promise.all([loadConversations(), loadSettings()])
  route()
}

function show(view) {
  ui.loadError.hidden = true
  ui.setup.hidden = view !== 'setup'
  ui.auth.hidden = view !== 'auth'
  ui.app.hidden = view !== 'app'
  if (view === 'auth' && !IS_TOUCH) ui.authEmail.focus()
}

function resetState() {
  state.stream?.controller.abort()
  Object.assign(state, {
    user: null,
    conversations: [],
    current: null,
    messages: [],
    draftInstructions: '',
    customInstructions: '',
    stream: null,
  })
  ui.thread.replaceChildren()
  ui.chatList.replaceChildren()
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
}

// ── Auth ─────────────────────────────────────────────────────────────────────

let authMode = 'signin'

function setAuthMode(mode) {
  authMode = mode
  const signUp = mode === 'signup'
  ui.authTitle.textContent = signUp ? 'Create an account' : 'Sign in'
  ui.authSubtitle.textContent = signUp
    ? 'Use your email and a password of at least 6 characters.'
    : 'Welcome back. Your chats are waiting.'
  ui.authSubmit.textContent = signUp ? 'Create account' : 'Sign in'
  ui.authToggle.textContent = signUp ? 'I already have an account' : 'Create an account'
  ui.authToggle.hidden = !ALLOW_SIGN_UP
  ui.authPassword.autocomplete = signUp ? 'new-password' : 'current-password'
  setAuthMessage('')
}

function setAuthMessage(text, kind = 'error') {
  ui.authMessage.textContent = text
  ui.authMessage.className = `form-message ${kind}`
}

ui.authToggle.addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'))

ui.authForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const email = ui.authEmail.value.trim()
  const password = ui.authPassword.value
  if (!email || !password) return setAuthMessage('Enter your email and password.')
  ui.authSubmit.disabled = true
  setAuthMessage('')
  const { data, error } = authMode === 'signup'
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password })
  ui.authSubmit.disabled = false
  if (error) return setAuthMessage(error.message)
  if (authMode === 'signup' && !data.session) {
    setAuthMode('signin')
    setAuthMessage('Check your inbox to confirm your email, then sign in here.', 'info')
  }
})

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadConversations() {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select(CONVERSATION_FIELDS)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) return toast(`Couldn't load your chats. ${dbHint(error)}`)
  state.conversations = data
  renderSidebar()
}

async function loadSettings() {
  const { data } = await supabase.from('chat_settings').select('custom_instructions').maybeSingle()
  state.customInstructions = data?.custom_instructions ?? ''
}

function dbHint(error) {
  if (error.code === 'PGRST205' || error.code === '42P01') return 'Run supabase/schema.sql in the SQL Editor first.'
  if (error.code === '42501') return 'Permission denied. Re-run supabase/schema.sql.'
  return error.message
}

// ── Navigation ───────────────────────────────────────────────────────────────

function route() {
  if (!state.user) return
  const id = location.hash.match(/^#\/c\/([0-9a-f-]{36})$/i)?.[1]
  if (id) openChat(id)
  else startNewChat()
}

function goToNewChat() {
  if (location.hash === '#/') startNewChat()
  else location.hash = '#/'
}

function startNewChat() {
  closeSidebar()
  state.loadSeq++
  state.current = null
  // A brand-new chat that is still streaming (no id yet) stays visible.
  const pending = state.stream && state.stream.conversationId === null
  state.messages = pending ? state.stream.messages : []
  if (!pending) state.draftInstructions = ''
  ui.title.value = ''
  ui.title.disabled = true
  ui.model.value = preferredModel()
  updateInstructionsChip()
  renderSidebar()
  renderThread()
  focusInput()
}

async function openChat(id) {
  closeSidebar()
  if (state.current?.id === id) return
  const seq = ++state.loadSeq
  let conversation = state.conversations.find((c) => c.id === id)
  if (!conversation) {
    const { data } = await supabase.from('chat_conversations').select(CONVERSATION_FIELDS).eq('id', id).maybeSingle()
    if (seq !== state.loadSeq) return
    if (!data) {
      toast('That chat no longer exists.')
      location.hash = '#/'
      return
    }
    conversation = data
  }
  state.current = conversation
  ui.title.value = conversation.title
  ui.title.disabled = false
  if (MODELS.some((m) => m.id === conversation.model)) ui.model.value = conversation.model
  updateInstructionsChip()
  renderSidebar()

  if (state.stream?.conversationId === id) {
    state.messages = state.stream.messages // still streaming: show the live reply
    renderThread()
    scrollToBottom()
    return
  }

  state.messages = []
  ui.main.classList.remove('is-empty')
  ui.thread.innerHTML = '<div class="thread-loading" aria-hidden="true"><span></span><span></span><span></span></div>'
  updateComposer()
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, role, content, model, finish_reason')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
  if (seq !== state.loadSeq) return
  if (error) {
    ui.thread.replaceChildren(el('div', 'msg-error', `Couldn't load this chat. ${dbHint(error)}`))
    return
  }
  state.messages = data
  renderThread()
  scrollToBottom()
  focusInput()
}

// ── Sending & streaming ──────────────────────────────────────────────────────

async function send() {
  const text = ui.input.value.trim()
  if (!text) return
  if (state.stream) {
    if (state.stream.messages !== state.messages) toast('Wait for the other reply to finish first.')
    return
  }
  const conversation = state.current
  const model = ui.model.value
  const reply = { role: 'assistant', content: '', model, pending: true }
  const stream = {
    controller: new AbortController(),
    messages: state.messages,
    reply,
    el: null,
    conversationId: conversation?.id ?? null,
    instructions: conversation ? null : state.draftInstructions,
  }
  state.messages.push({ role: 'user', content: text }, reply)
  state.stream = stream
  ui.input.value = ''
  autosize()
  renderThread()
  scrollToBottom()
  announce('Waiting for the reply…')

  let finished = false
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Your session has expired. Sign in again.')
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify({
        conversation_id: conversation?.id ?? null,
        message: text,
        model,
        system_prompt: stream.instructions || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      signal: stream.controller.signal,
    })
    if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error(await responseError(res))
    }
    for await (const event of readEvents(res.body)) {
      if (event.type === 'meta') onMeta(event, stream)
      else if (event.type === 'thinking') {
        reply.thinking = true
        queuePaint()
      } else if (event.type === 'delta') {
        reply.content += event.text
        queuePaint()
      } else if (event.type === 'error') reply.error = event.message
      else if (event.type === 'done') {
        finished = true
        reply.id = event.message_id
        reply.finish_reason = event.finish_reason
        if (!event.saved) reply.warning = "This reply couldn't be saved to your history."
      }
    }
    if (!finished && !reply.error) reply.error = 'The connection closed before the reply finished.'
  } catch (err) {
    if (err?.name === 'AbortError') reply.finish_reason = 'stopped'
    else reply.error = friendlyError(err)
  } finally {
    reply.pending = false
    state.stream = null
    if (stream.el?.isConnected) {
      const stick = nearBottom()
      paintMessage(reply, stream.el)
      if (stick) scrollToBottom()
    }
    updateComposer()
    announce(reply.error ? 'The reply failed.' : 'Reply finished.')
  }
}

function stop() {
  state.stream?.controller.abort()
}

function onMeta(event, stream) {
  stream.conversationId = event.conversation_id
  const viewing = state.messages === stream.messages
  if (event.created) {
    const conversation = {
      id: event.conversation_id,
      title: event.title,
      model: event.model,
      system_prompt: stream.instructions ?? '',
      updated_at: new Date().toISOString(),
    }
    state.conversations.unshift(conversation)
    if (viewing) {
      state.current = conversation
      state.draftInstructions = ''
      history.replaceState(null, '', `#/c/${conversation.id}`)
      ui.title.value = conversation.title
      ui.title.disabled = false
      updateInstructionsChip()
    }
  } else {
    const i = state.conversations.findIndex((c) => c.id === event.conversation_id)
    if (i >= 0) {
      const [conversation] = state.conversations.splice(i, 1)
      conversation.updated_at = new Date().toISOString()
      conversation.model = event.model
      state.conversations.unshift(conversation)
    }
  }
  renderSidebar()
}

/** Reads the function's server-sent events. */
async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    let cut
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (!data) continue // keep-alive comment
      try {
        yield JSON.parse(data)
      } catch { /* ignore malformed event */ }
    }
  }
}

async function responseError(res) {
  let message = ''
  try {
    const body = await res.json()
    message = body.error || body.message || body.msg || ''
  } catch { /* not JSON */ }
  if (res.status === 401 && (!message || /jwt/i.test(message))) {
    return 'Your session has expired. Sign out and sign in again.'
  }
  if (res.status === 404 && /function/i.test(message)) {
    return 'The "chat" Edge Function isn\'t deployed yet. See the README.'
  }
  return message || `Something went wrong (HTTP ${res.status}).`
}

function friendlyError(err) {
  if (err instanceof TypeError) {
    return 'Couldn\'t reach Supabase. Check your connection and SUPABASE_URL in config.js.'
  }
  return err?.message || String(err)
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderThread() {
  ui.thread.replaceChildren(...state.messages.map((message) => {
    const node = el('div', `msg ${message.role}`)
    paintMessage(message, node)
    if (state.stream?.reply === message) state.stream.el = node
    return node
  }))
  ui.main.classList.toggle('is-empty', state.messages.length === 0)
  updateComposer()
}

function paintMessage(message, node) {
  if (message.role === 'user') {
    node.replaceChildren(el('div', 'bubble', message.content))
    return
  }
  const parts = []
  if (message.content) {
    const md = el('div', 'md')
    renderMarkdown(md, message.content)
    parts.push(md)
  } else if (message.pending) {
    parts.push(message.thinking ? el('div', 'thinking', 'Thinking…') : typingDots())
  }
  const note = noteFor(message)
  if (note) parts.push(el('div', 'msg-note', note))
  if (message.error) parts.push(el('div', 'msg-error', message.error))
  if (!message.pending && message.content) parts.push(messageMeta(message))
  node.replaceChildren(...parts)
}

function noteFor(message) {
  if (message.pending) return ''
  if (message.finish_reason === 'stopped') return 'Stopped.'
  if (message.finish_reason === 'length') return 'This reply hit the length limit and was cut off.'
  if (message.finish_reason === 'error' && !message.error) return 'This reply was interrupted.'
  return message.warning ?? ''
}

function messageMeta(message) {
  const row = el('div', 'msg-meta')
  const copy = iconButton('i-copy', 'Copy reply')
  copy.addEventListener('click', () => copyText(message.content, copy))
  row.append(copy)
  if (message.model) row.append(el('span', 'msg-model', modelLabel(message.model)))
  return row
}

function typingDots() {
  const dots = el('div', 'typing')
  dots.setAttribute('aria-label', 'Waiting for the reply')
  dots.append(el('span'), el('span'), el('span'))
  return dots
}

let paintQueued = false
function queuePaint() {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => {
    paintQueued = false
    const stream = state.stream
    if (!stream?.el?.isConnected) return
    const stick = nearBottom()
    paintMessage(stream.reply, stream.el)
    if (stick) scrollToBottom()
  })
}

function renderSidebar() {
  if (state.conversations.length === 0) {
    ui.chatList.replaceChildren(el('p', 'chat-list-empty', 'Your chats will show up here.'))
    return
  }
  const DAY = 86_400_000
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const groups = new Map()
  for (const conversation of state.conversations) {
    const t = new Date(conversation.updated_at).getTime()
    const label = t >= today
      ? 'Today'
      : t >= today - DAY
      ? 'Yesterday'
      : t >= today - 7 * DAY
      ? 'Previous 7 days'
      : t >= today - 30 * DAY
      ? 'Previous 30 days'
      : 'Older'
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(conversation)
  }
  const nodes = []
  for (const [label, conversations] of groups) {
    const group = el('div', 'chat-group')
    group.append(el('div', 'chat-group-label', label))
    for (const conversation of conversations) {
      const active = state.current?.id === conversation.id
      const item = el('div', `chat-item${active ? ' active' : ''}`)
      const link = el('a', '', conversation.title || 'New chat')
      link.href = `#/c/${conversation.id}`
      link.title = conversation.title
      link.addEventListener('click', closeSidebar) // also when it's the chat already open
      if (active) link.setAttribute('aria-current', 'page')
      const remove = iconButton('i-trash', 'Delete chat')
      remove.addEventListener('click', () => deleteChat(conversation))
      item.append(link, remove)
      group.append(item)
    }
    nodes.push(group)
  }
  ui.chatList.replaceChildren(...nodes)
}

function updateComposer() {
  const streamingHere = Boolean(state.stream) && state.stream.messages === state.messages
  ui.send.setAttribute('aria-label', streamingHere ? 'Stop' : 'Send')
  ui.send.title = streamingHere ? 'Stop' : 'Send'
  ui.send.querySelector('use').setAttribute('href', streamingHere ? '#i-stop' : '#i-up')
  ui.send.disabled = !streamingHere && !ui.input.value.trim()
}

function updateInstructionsChip() {
  const value = state.current ? state.current.system_prompt : state.draftInstructions
  ui.instructionsBtn.classList.toggle('is-set', Boolean(value?.trim()))
}

// ── Chat actions ─────────────────────────────────────────────────────────────

async function deleteChat(conversation) {
  if (!confirm(`Delete "${conversation.title}"? This can't be undone.`)) return
  if (state.stream?.conversationId === conversation.id) state.stream.controller.abort()
  const { error } = await supabase.from('chat_conversations').delete().eq('id', conversation.id)
  if (error) return toast(`Couldn't delete the chat. ${dbHint(error)}`)
  state.conversations = state.conversations.filter((c) => c.id !== conversation.id)
  renderSidebar()
  if (state.current?.id === conversation.id) goToNewChat()
}

ui.title.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') ui.title.blur()
  if (event.key === 'Escape') {
    ui.title.value = state.current?.title ?? ''
    ui.title.blur()
  }
})

ui.title.addEventListener('change', async () => {
  const conversation = state.current
  if (!conversation) return
  const title = ui.title.value.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!title || title === conversation.title) {
    ui.title.value = conversation.title
    return
  }
  const previous = conversation.title
  conversation.title = title
  renderSidebar()
  const { error } = await supabase.from('chat_conversations').update({ title }).eq('id', conversation.id)
  if (error) {
    conversation.title = previous
    if (state.current === conversation) ui.title.value = previous
    renderSidebar()
    toast(`Couldn't rename the chat. ${dbHint(error)}`)
  }
})

ui.instructionsBtn.addEventListener('click', () => {
  ui.instructionsText.value = state.current ? state.current.system_prompt ?? '' : state.draftInstructions
  ui.instructionsDialog.returnValue = ''
  ui.instructionsDialog.showModal()
})

ui.instructionsDialog.addEventListener('close', async () => {
  if (ui.instructionsDialog.returnValue !== 'save') return
  const value = ui.instructionsText.value.trim()
  const conversation = state.current
  if (!conversation) {
    state.draftInstructions = value
    updateInstructionsChip()
    return
  }
  if (value === (conversation.system_prompt ?? '')) return
  const previous = conversation.system_prompt
  conversation.system_prompt = value
  updateInstructionsChip()
  const { error } = await supabase.from('chat_conversations').update({ system_prompt: value }).eq('id', conversation.id)
  if (error) {
    conversation.system_prompt = previous
    updateInstructionsChip()
    toast(`Couldn't save the instructions. ${dbHint(error)}`)
  } else toast('Instructions saved. They apply from your next message.')
})

ui.account.addEventListener('click', () => {
  ui.customInstructions.value = state.customInstructions
  ui.settingsEmail.textContent = state.user?.email ?? ''
  ui.settingsDialog.returnValue = ''
  ui.settingsDialog.showModal()
})

ui.settingsDialog.addEventListener('close', async () => {
  if (ui.settingsDialog.returnValue !== 'save') return
  const value = ui.customInstructions.value.trim()
  if (value === state.customInstructions) return
  const { error } = await supabase
    .from('chat_settings')
    .upsert({ user_id: state.user.id, custom_instructions: value, updated_at: new Date().toISOString() })
  if (error) return toast(`Couldn't save your settings. ${dbHint(error)}`)
  state.customInstructions = value
  toast('Custom instructions saved.')
})

ui.signOut.addEventListener('click', async () => {
  ui.settingsDialog.close()
  await supabase.auth.signOut()
})

// ── Composer ─────────────────────────────────────────────────────────────────

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  if (state.stream && state.stream.messages === state.messages) stop()
  else send()
})

ui.input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || IS_TOUCH) return
  event.preventDefault()
  const streamingHere = state.stream && state.stream.messages === state.messages
  if (!streamingHere) ui.composer.requestSubmit()
})

ui.input.addEventListener('input', autosize)

function autosize() {
  ui.input.style.height = 'auto'
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 240)}px`
  updateComposer()
}

function fillModelPicker() {
  // Models with a `group` are shown under that heading (<optgroup>), in config order.
  const nodes = []
  const groups = new Map()
  for (const m of MODELS) {
    const option = new Option(m.label || m.id, m.id)
    if (!m.group) {
      nodes.push(option)
      continue
    }
    if (!groups.has(m.group)) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = m.group
      groups.set(m.group, optgroup)
      nodes.push(optgroup)
    }
    groups.get(m.group).append(option)
  }
  ui.model.replaceChildren(...nodes)
  ui.model.value = preferredModel()
  ui.model.addEventListener('change', () => store.set('chat.model', ui.model.value))
}

function preferredModel() {
  const saved = store.get('chat.model')
  return MODELS.some((m) => m.id === saved) ? saved : MODELS[0].id
}

function modelLabel(id) {
  return MODELS.find((m) => m.id === id)?.label ?? id
}

// ── Sidebar (mobile) ─────────────────────────────────────────────────────────

const closeSidebar = () => ui.app.classList.remove('sidebar-open')
ui.menuBtn.addEventListener('click', () => ui.app.classList.add('sidebar-open'))
ui.scrim.addEventListener('click', closeSidebar)
ui.newChat.addEventListener('click', goToNewChat)
ui.topbarNew.addEventListener('click', goToNewChat)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSidebar()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function el(tag, className = '', text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(icon, label) {
  const button = el('button', 'icon-btn sm')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>`
  return button
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text })
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  if (button.classList.contains('code-copy')) {
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy'), 1500)
  } else {
    const use = button.querySelector('use')
    use.setAttribute('href', '#i-check')
    setTimeout(() => use.setAttribute('href', '#i-copy'), 1500)
  }
}

const nearBottom = () => ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80
const scrollToBottom = () => (ui.messages.scrollTop = ui.messages.scrollHeight)
const focusInput = () => !IS_TOUCH && ui.input.focus()
const announce = (text) => (ui.srStatus.textContent = text)

let toastTimer
function toast(message) {
  ui.toast.textContent = message
  ui.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 4000)
}

// ── Boot (last, so everything above is initialised) ──────────────────────────

if (!supabase) {
  show('setup')
} else {
  fillModelPicker()
  setAuthMode('signin')
  supabase.auth.onAuthStateChange((_event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => onSession(session), 0)
  })
  window.addEventListener('hashchange', route)
}
