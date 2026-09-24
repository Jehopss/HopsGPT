// Minimal Chat — frontend. Plain ES modules, no build step.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm'
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.0.13/lib/marked.esm.js'
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.15/dist/purify.es.mjs'
import * as config from './config.js'
import { artifactCard, collectArtifacts, createArtifactPanel, plainText, splitReply } from './artifacts.js'
import { extOf, formatSize, MAX_FILES, readAttachment, storageName, typeLabel } from './files.js'
import { addMessage, branchFor, createTree, lastLeaf, pathTo, siblingsOf, treeFrom } from './tree.js'
import { createAmbient } from './ambient.js'

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
const MESSAGE_FIELDS = 'id, role, content, model, finish_reason, created_at'
const ATTACHMENT_FIELDS = 'id, message_id, name, mime, size, kind, storage_path, image_paths, position, meta'
const BUCKET = 'chat-files'
const UPGRADE_V3 = 'Files, editing and retrying need a database update: run supabase/upgrade-v3.sql in the SQL Editor.'
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
  attachBtn: $('attach-btn'), fileInput: $('file-input'), composerFiles: $('composer-files'), ambient: $('ambient'),
  lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxName: $('lightbox-name'),
  lightboxDownload: $('lightbox-download'), lightboxClose: $('lightbox-close'),
  instructionsDialog: $('instructions-dialog'), instructionsText: $('instructions-text'),
  search: $('chat-search'),
  settingsDialog: $('settings-dialog'), settingsClose: $('settings-close'), settingsUpgrade: $('settings-upgrade'),
  themeControl: $('theme-control'), setNotify: $('set-notify'),
  customInstructions: $('custom-instructions'), saveInstructions: $('save-instructions'),
  usageReset: $('usage-reset'), usageMonthCost: $('usage-month-cost'), usageMonthTokens: $('usage-month-tokens'),
  usageMeter: $('usage-meter'), usageMeterFill: $('usage-meter-fill'), usageMeterLabel: $('usage-meter-label'),
  usageChart: $('usage-chart'), usageTodayCost: $('usage-today-cost'), usageTodayTokens: $('usage-today-tokens'),
  usageTodayReplies: $('usage-today-replies'), usageModels: $('usage-models'), usageUpdated: $('usage-updated'),
  usageRefresh: $('usage-refresh'), setBudget: $('set-budget'),
  setArtifacts: $('set-artifacts'), setReference: $('set-reference'), setMemory: $('set-memory'),
  memoryCount: $('memory-count'), memoryList: $('memory-list'), memoryForm: $('memory-form'),
  memoryInstruction: $('memory-instruction'), memorySubmit: $('memory-submit'), memoryClear: $('memory-clear'),
  settingsEmail: $('settings-email'), signOut: $('sign-out'), exportData: $('export-data'), deleteAll: $('delete-all'),
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
  messages: [], // the branch of the chat on screen, first message → last
  tree: createTree(), // every message of the chat on screen, incl. other versions (edits, retries)
  composerFiles: [], // files attached to the message being written
  draftInstructions: '', // instructions for a chat that doesn't exist yet
  customInstructions: '',
  prefs: {}, // chat_settings.preferences: { artifacts, memory, referenceChats, monthlyBudget }
  v2: true, // false until supabase/upgrade-v2.sql has been run
  v3: true, // false until supabase/upgrade-v3.sql has been run (files, edit, retry)
  memories: [],
  stream: null, // { controller, messages, tree, reply, userMessage, el, conversationId, instructions, autoOpened, finalized }
  loadSeq: 0,
  searchSeq: 0,
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

// ── Artifact panel ───────────────────────────────────────────────────────────

const artifactPanel = createArtifactPanel({
  els: {
    root: $('artifact-panel'), title: $('ap-title'), meta: $('ap-meta'),
    versions: $('ap-versions'), version: $('ap-version'), prev: $('ap-prev'), next: $('ap-next'),
    tabPreview: $('ap-tab-preview'), tabCode: $('ap-tab-code'), body: $('ap-body'),
    close: $('ap-close'), download: $('ap-download'),
  },
  renderMarkdown,
  onOpenChange: (open) => ui.app.classList.toggle('artifact-open', open),
})
$('ap-copy').addEventListener('click', (event) => copyText(artifactPanel.copyText(), event.currentTarget))
const WIDE_SCREEN = window.matchMedia('(min-width: 900px)')

function openArtifact(id, index, options) {
  artifactPanel.update(state.messages)
  artifactPanel.open(id, index, options)
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
  await Promise.all([loadConversations(), loadSettings(), detectV3()])
  route()
  if (state.v3) cleanUpUnsentFiles()
}

function show(view) {
  ui.loadError.hidden = true
  ui.setup.hidden = view !== 'setup'
  ui.auth.hidden = view !== 'auth'
  ui.app.hidden = view !== 'app'
  if (view !== 'app') ambient.stop()
  if (view === 'auth' && !IS_TOUCH) ui.authEmail.focus()
}

function resetState() {
  state.stream?.controller.abort()
  for (const item of state.composerFiles) if (item.preview) URL.revokeObjectURL(item.preview)
  Object.assign(state, {
    user: null,
    conversations: [],
    current: null,
    messages: [],
    tree: createTree(),
    composerFiles: [],
    draftInstructions: '',
    customInstructions: '',
    prefs: {},
    memories: [],
    stream: null,
  })
  usageRows = null
  artifactPanel.close()
  if (ui.settingsDialog.open) ui.settingsDialog.close()
  ui.search.value = ''
  ui.thread.replaceChildren()
  ui.chatList.replaceChildren()
  renderComposerFiles()
  signedUrls.clear()
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
  let res = await supabase.from('chat_settings').select('custom_instructions, preferences').maybeSingle()
  state.v2 = !res.error
  if (res.error) {
    // Database not upgraded yet (no `preferences` column): fall back to v1 settings.
    res = await supabase.from('chat_settings').select('custom_instructions').maybeSingle()
  }
  state.customInstructions = res.data?.custom_instructions ?? ''
  state.prefs = res.data?.preferences ?? {}
}

/** Saves preference changes. Returns false (and restores the old values) if saving fails. */
async function savePrefs(patch) {
  const previous = state.prefs
  state.prefs = { ...state.prefs, ...patch }
  const { error } = await supabase
    .from('chat_settings')
    .upsert({ user_id: state.user.id, preferences: state.prefs, updated_at: new Date().toISOString() })
  if (!error) return true
  state.prefs = previous
  toast(`Couldn't save that setting. ${dbHint(error)}`)
  return false
}

/** Whether supabase/upgrade-v3.sql has been run. */
async function detectV3() {
  const { error } = await supabase.from('chat_attachments').select('id').limit(1)
  state.v3 = !['PGRST205', '42P01', 'PGRST204', '42703'].includes(error?.code ?? '')
}

function dbHint(error) {
  if (/chat_attachments|parent_id|current_leaf_id|chat_message_path|[Bb]ucket not found/.test(error.message ?? '')) {
    return 'Run supabase/upgrade-v3.sql in the SQL Editor first.'
  }
  if (/chat_memories|preferences|chat_usage|search_chat_messages|tokens_estimated/.test(error.message ?? '')) {
    return 'Run supabase/upgrade-v2.sql in the SQL Editor first.'
  }
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
  // Switch right away (not on the async hashchange), so text typed straight after
  // clicking "New chat" can never end up in the previous chat.
  if (location.hash !== '#/') history.pushState(null, '', '#/')
  startNewChat()
}

function startNewChat() {
  closeSidebar()
  artifactPanel.close()
  state.loadSeq++
  state.current = null
  // A brand-new chat that is still streaming (no id yet) stays visible.
  const pending = state.stream && state.stream.conversationId === null
  state.messages = pending ? state.stream.messages : []
  state.tree = pending ? state.stream.tree : createTree()
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
  artifactPanel.close()
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
    state.tree = state.stream.tree
    renderThread()
    scrollToBottom()
    return
  }

  state.messages = []
  state.tree = createTree()
  setEmpty(false)
  ui.thread.innerHTML = '<div class="thread-loading" aria-hidden="true"><span></span><span></span><span></span></div>'
  updateComposer()
  let loaded
  try {
    loaded = await loadChat(id)
  } catch (err) {
    if (seq !== state.loadSeq) return
    ui.thread.replaceChildren(el('div', 'msg-error', `Couldn't load this chat. ${err.message}`))
    return
  }
  if (seq !== state.loadSeq) return
  state.tree = loaded.tree
  state.messages = branchFor(loaded.tree, loaded.leaf)
  renderThread()
  scrollToBottom()
  focusInput()
}

/** Every message of a chat (all versions), its files, and the branch viewed last. */
async function loadChat(id) {
  const fields = state.v3 ? `${MESSAGE_FIELDS}, parent_id` : MESSAGE_FIELDS
  const [rows, files, leaf] = await Promise.all([
    fetchAll(() => supabase.from('chat_messages').select(fields).eq('conversation_id', id).order('created_at', { ascending: true })),
    state.v3
      ? fetchAll(() => supabase.from('chat_attachments').select(ATTACHMENT_FIELDS).eq('conversation_id', id).order('position', { ascending: true }))
      : [],
    state.v3
      ? supabase.from('chat_conversations').select('current_leaf_id').eq('id', id).maybeSingle().then((r) => r.data?.current_leaf_id ?? null)
      : null,
  ])
  const byMessage = new Map()
  for (const file of files) {
    if (!byMessage.has(file.message_id)) byMessage.set(file.message_id, [])
    byMessage.get(file.message_id).push(file)
  }
  for (const row of rows) row.attachments = byMessage.get(row.id) ?? []
  return { tree: treeFrom(rows, { linear: !state.v3 }), leaf }
}

// ── Sending & streaming ──────────────────────────────────────────────────────

const isBusy = (item) => item.status === 'reading' || item.status === 'uploading'

async function send() {
  const text = ui.input.value.trim()
  const items = state.composerFiles
  const ready = items.filter((item) => item.status === 'ready')
  if (!text && !ready.length) return
  if (items.some(isBusy)) return toast('Wait for your files to finish uploading.')
  if (state.stream) {
    if (state.stream.messages !== state.messages) toast('Wait for the other reply to finish first.')
    return
  }
  const failed = items.filter((item) => item.status === 'error')
  const turn = runTurn({ text, files: ready.map(sentFile) })
  ui.input.value = ''
  state.composerFiles = []
  autosize()
  renderComposerFiles()
  if (failed.length) {
    toast(`${failed.map((f) => `“${f.name}”`).join(', ')} couldn't be attached, so ${failed.length === 1 ? 'it was' : 'they were'} left out.`)
  }
  await turn
}

/**
 * Sends a message and streams the reply. Also used for an edited message
 * (`edit`: the message it replaces, which stays as an older version) and for
 * Retry (`retry`: the user message to answer again, with the model picked now).
 */
async function runTurn({ text = '', files = [], edit = null, retry = null }) {
  const conversation = state.current
  const model = ui.model.value
  const reply = { role: 'assistant', content: '', model, pending: true }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let path
  let userMessage
  let body
  if (retry) {
    userMessage = retry
    path = [...state.messages.slice(0, state.messages.indexOf(retry) + 1), reply]
    body = { action: 'regenerate', conversation_id: conversation.id, message_id: retry.id, model, timezone }
  } else {
    const base = edit ? state.messages.slice(0, state.messages.indexOf(edit)) : state.messages
    userMessage = { role: 'user', content: text, attachments: files, pending: true }
    path = [...base, userMessage, reply]
    body = { conversation_id: conversation?.id ?? null, message: text, model, timezone }
    if (!conversation && state.draftInstructions) body.system_prompt = state.draftInstructions
    if (files.length) body.attachment_ids = files.map((f) => f.id)
    if (conversation && state.v3) {
      // Reply to what's on screen: the end of this branch, or (edit) the message before the edited one.
      // If the last reply was never confirmed (e.g. cut off), the server continues from the newest saved one.
      const last = base.at(-1)
      if (edit?.id) body.parent_id = edit.parent_id ?? null
      else if (!last || last.id) body.parent_id = last?.id ?? null
    }
  }
  const stream = {
    controller: new AbortController(),
    messages: path,
    tree: state.tree,
    reply,
    userMessage,
    retry: Boolean(retry),
    el: null,
    conversationId: conversation?.id ?? null,
    instructions: conversation ? null : state.draftInstructions,
  }
  state.messages = path
  state.stream = stream
  renderThread()
  scrollToBottom()
  announce('Waiting for the reply…')

  // The reply joins the chat's tree once it's saved (its id arrives before it's finished).
  const keepReply = (id) => {
    if (!id || reply.id) return
    reply.id = id
    if (!state.v3) return
    reply.parent_id = userMessage.id
    addMessage(stream.tree, reply)
    const node = nodeFor.get(reply)
    if (node) node.dataset.id = id
  }

  let finished = false
  // The reply is "done" as soon as its text is complete. The connection may stay
  // open a little longer while the server updates memory in the background.
  const finalize = () => {
    if (stream.finalized) return
    stream.finalized = true
    reply.pending = false
    userMessage.pending = false
    if (state.stream === stream) state.stream = null
    if (state.messages === stream.messages) {
      // Repaint the whole branch: version counters (‹ 2/2 ›) and actions change now.
      const stick = nearBottom()
      const top = ui.messages.scrollTop
      renderThread()
      if (stick) scrollToBottom()
      else ui.messages.scrollTop = top
    } else updateComposer()
    announce(reply.error ? 'The reply failed.' : 'Reply finished.')
    if (!reply.error && reply.content && reply.finish_reason !== 'stopped') notifyReply(reply)
  }

  try {
    const res = await callFunction(body, stream.controller.signal)
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
      } else if (event.type === 'saved') keepReply(event.message_id)
      else if (event.type === 'error') reply.error = event.message
      else if (event.type === 'done') {
        finished = true
        reply.finish_reason = event.finish_reason
        keepReply(event.message_id)
        if (!event.saved) reply.warning = "This reply couldn't be saved to your history."
        finalize()
      } else if (event.type === 'memory') onMemoryUpdated(event.changes)
    }
    if (!finished && !reply.error) reply.error = 'The connection closed before the reply finished.'
  } catch (err) {
    if (!stream.finalized) {
      if (err?.name === 'AbortError') reply.finish_reason = 'stopped'
      else reply.error = friendlyError(err)
    }
  } finally {
    finalize()
  }
}

/** POSTs to the Edge Function as the signed-in user. */
async function callFunction(body, signal) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Your session has expired. Sign in again.')
  return fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify(body),
    signal,
  })
}

function stop() {
  state.stream?.controller.abort()
}

function onMeta(event, stream) {
  stream.conversationId = event.conversation_id
  const viewing = state.messages === stream.messages
  if (!stream.retry) {
    const message = stream.userMessage
    message.id = event.user_message_id
    message.parent_id = event.parent_id ?? null
    message.pending = false
    if (state.v3) addMessage(stream.tree, message)
    if (viewing && siblingsOf(stream.tree, message).length > 1) {
      const node = nodeFor.get(message)
      if (node?.isConnected) paintMessage(message, node) // an edit: show ‹ 2/2 › right away
    }
  }
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

const nodeFor = new WeakMap() // message → its element in the thread

function renderThread() {
  ui.thread.replaceChildren(...state.messages.map((message) => {
    const node = el('div', `msg ${message.role}`)
    if (message.id) node.dataset.id = message.id
    nodeFor.set(message, node)
    paintMessage(message, node)
    if (state.stream?.reply === message) state.stream.el = node
    return node
  }))
  setEmpty(state.messages.length === 0)
  artifactPanel.update(state.messages)
  updateComposer()
}

// Background animation on the empty "new chat" screen
const ambient = createAmbient(ui.ambient)
let ambientTimer

function setEmpty(empty) {
  ui.main.classList.toggle('is-empty', empty)
  clearTimeout(ambientTimer)
  if (empty && !ui.app.hidden) ambient.start()
  else ambientTimer = setTimeout(() => ambient.stop(), 700) // after it has faded out
}

function paintMessage(message, node) {
  node.classList.remove('editing')
  if (message.role === 'user') {
    const parts = []
    if (message.attachments?.length) parts.push(messageFiles(message.attachments))
    if (message.content) parts.push(el('div', 'bubble', message.content))
    if (!message.pending) parts.push(userActions(message))
    node.replaceChildren(...parts)
    return
  }
  const parts = []
  if (message.content) {
    // Text is rendered as Markdown; each <artifact> becomes a card that opens the side panel.
    const list = state.stream?.reply === message ? state.stream.messages : state.messages
    const index = list.indexOf(message)
    let versions = null
    for (const part of splitReply(message.content, message.pending)) {
      if (part.kind === 'text') {
        if (!part.text.trim()) continue
        const md = el('div', 'md')
        renderMarkdown(md, part.text)
        parts.push(md)
      } else {
        versions ??= collectArtifacts(list)
        const all = versions.get(part.id) ?? []
        const position = all.findIndex((v) => v.messageIndex === index && v.content === part.content)
        parts.push(artifactCard(part, position >= 0 ? position + 1 : all.length || 1, openArtifact))
      }
    }
    if (parts.length === 0 && message.pending) parts.push(typingDots())
  } else if (message.pending) {
    parts.push(message.thinking ? el('div', 'thinking', 'Thinking…') : typingDots())
  }
  const note = noteFor(message)
  if (note) parts.push(el('div', 'msg-note', note))
  if (message.error) parts.push(el('div', 'msg-error', message.error))
  if (!message.pending && (message.content || message.error || message.finish_reason)) parts.push(messageMeta(message))
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
  if (message.content) {
    const copy = iconButton('i-copy', 'Copy reply')
    copy.addEventListener('click', () => copyText(plainText(message.content), copy))
    row.append(copy)
  }
  const retry = iconButton('i-refresh', 'Retry')
  const retryLabel = () => {
    const label = `Retry with ${modelLabel(ui.model.value)}`
    retry.title = label
    retry.setAttribute('aria-label', label)
  }
  retry.addEventListener('pointerenter', retryLabel)
  retry.addEventListener('focus', retryLabel)
  retry.addEventListener('click', () => retryReply(message))
  row.append(retry)
  const versions = versionSwitcher(message)
  if (versions) row.append(versions)
  if (message.model) row.append(el('span', 'msg-model', modelLabel(message.model)))
  return row
}

function userActions(message) {
  const row = el('div', 'msg-meta user-meta')
  const versions = versionSwitcher(message)
  if (versions) row.append(versions)
  if (message.content) {
    const copy = iconButton('i-copy', 'Copy message')
    copy.addEventListener('click', () => copyText(message.content, copy))
    row.append(copy)
  }
  const edit = iconButton('i-edit', 'Edit message')
  edit.addEventListener('click', () => startEdit(message))
  row.append(edit)
  return row
}

// ── Versions: edit & retry ───────────────────────────────────────────────────

/** ‹ 2/3 › for a message that has other versions. */
function versionSwitcher(message) {
  const siblings = siblingsOf(state.tree, message)
  if (siblings.length < 2) return null
  const i = siblings.indexOf(message)
  const box = el('span', 'versions')
  const prev = iconButton('i-chevron-left', 'Previous version')
  const next = iconButton('i-chevron-right', 'Next version')
  prev.dataset.dir = 'prev'
  next.dataset.dir = 'next'
  prev.disabled = i <= 0
  next.disabled = i >= siblings.length - 1
  prev.addEventListener('click', () => showVersion(siblings[i - 1], message, 'prev'))
  next.addEventListener('click', () => showVersion(siblings[i + 1], message, 'next'))
  const label = el('span', 'versions-label', `${i + 1} / ${siblings.length}`)
  label.setAttribute('aria-label', `Version ${i + 1} of ${siblings.length}`)
  box.append(prev, label, next)
  return box
}

function showVersion(target, from, dir) {
  if (!target) return
  if (state.stream && state.stream.messages === state.messages) return toast('Wait for the reply to finish first.')
  // Keep the switcher under the pointer: the thread below it changes, the part above doesn't.
  const before = nodeFor.get(from)?.getBoundingClientRect().top
  const leaf = lastLeaf(state.tree, target.id)
  state.messages = pathTo(state.tree, leaf.id)
  renderThread()
  const node = nodeFor.get(target)
  if (node && before !== undefined) ui.messages.scrollTop += node.getBoundingClientRect().top - before
  const button = node?.querySelector(`.versions [data-dir="${dir}"]`)
  ;(button && !button.disabled ? button : node?.querySelector('.versions button:not(:disabled)'))?.focus({ preventScroll: true })
  saveLeaf(leaf.id)
}

let leafTimer
/** Remembers the version on screen, so the chat reopens on it (also on your other devices). */
function saveLeaf(id) {
  const conversation = state.current
  if (!conversation || !state.v3 || !id) return
  clearTimeout(leafTimer)
  leafTimer = setTimeout(async () => {
    const { error } = await supabase.from('chat_conversations').update({ current_leaf_id: id }).eq('id', conversation.id)
    if (error) console.warn('Could not save the version on screen', error)
  }, 400)
}

function retryReply(reply) {
  if (state.stream) return toast('Wait for the reply to finish first.')
  const i = state.messages.indexOf(reply)
  const user = state.messages.slice(0, i).findLast((m) => m.role === 'user')
  if (!user) return
  if (!user.id) {
    // The message itself never reached the server: just send it again.
    state.messages = state.messages.slice(0, state.messages.indexOf(user))
    runTurn({ text: user.content, files: user.attachments ?? [] })
    return
  }
  if (!state.v3) return toast(UPGRADE_V3)
  runTurn({ retry: user })
}

function startEdit(message) {
  if (state.stream) return toast('Wait for the reply to finish first.')
  if (message.id && !state.v3) return toast(UPGRADE_V3)
  const node = nodeFor.get(message)
  if (!node) return
  const form = el('form', 'edit-box')
  const area = el('textarea', 'edit-input')
  area.value = message.content
  area.rows = 1
  area.setAttribute('aria-label', 'Edit message')
  const grow = () => {
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 320)}px`
  }
  area.addEventListener('input', grow)
  const cancel = el('button', 'btn', 'Cancel')
  cancel.type = 'button'
  const save = el('button', 'btn primary', 'Send')
  save.type = 'submit'
  const actions = el('div', 'edit-actions')
  actions.append(
    el('span', 'edit-note', 'Sending starts a new version of the chat from here. The current version stays available.'),
    cancel,
    save,
  )
  if (message.attachments?.length) form.append(messageFiles(message.attachments))
  form.append(area, actions)
  node.classList.add('editing')
  node.replaceChildren(form)
  grow()
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)

  const close = () => paintMessage(message, node)
  cancel.addEventListener('click', close)
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !IS_TOUCH) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = area.value.trim()
    if (!text && !message.attachments?.length) return area.focus()
    if (text === message.content.trim()) return close()
    if (state.stream) return toast('Wait for the reply to finish first.')
    runTurn({ text, files: message.attachments ?? [], edit: message })
  })
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
    if (stream.messages !== state.messages) return
    // The first artifact of a reply opens the panel by itself (on wide screens), like Claude.
    if (!stream.autoOpened && WIDE_SCREEN.matches) {
      const first = splitReply(stream.reply.content, true).find((p) => p.kind === 'artifact')
      if (first) {
        stream.autoOpened = true
        openArtifact(first.id, null, { focus: false })
        return
      }
    }
    artifactPanel.update(state.messages)
  })
}

function renderSidebar() {
  if (ui.search.value.trim()) return void runSearch()
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

// ── Search ───────────────────────────────────────────────────────────────────

let searchTimer
ui.search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 220)
})
ui.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !ui.search.value) return
  event.stopPropagation()
  ui.search.value = ''
  renderSidebar()
})

/** Titles match as you type; message text is searched word by word in the database. */
async function runSearch() {
  const query = ui.search.value.trim()
  const seq = ++state.searchSeq
  if (!query) return renderSidebar()
  const lower = query.toLowerCase()
  const titleHits = state.conversations
    .filter((c) => (c.title || '').toLowerCase().includes(lower))
    .map((c) => ({ id: c.id, title: c.title, snippet: '' }))
  renderSearchResults(query, titleHits, state.v2)
  if (!state.v2) return
  const { data, error } = await supabase.rpc('search_chat_messages', {
    query,
    exclude_conversation: null,
    match_count: 20,
  })
  if (seq !== state.searchSeq) return
  const seen = new Set(titleHits.map((h) => h.id))
  const textHits = []
  for (const row of error ? [] : data ?? []) {
    if (seen.has(row.conversation_id)) continue
    seen.add(row.conversation_id)
    textHits.push({ id: row.conversation_id, title: row.title, snippet: plainText(row.snippet ?? '') })
  }
  renderSearchResults(query, [...titleHits, ...textHits], false)
}

function renderSearchResults(query, hits, searching) {
  const nodes = [el('div', 'chat-group-label', searching ? 'Searching…' : `${hits.length} result${hits.length === 1 ? '' : 's'}`)]
  for (const hit of hits) {
    const item = el('div', `chat-item search-item${state.current?.id === hit.id ? ' active' : ''}`)
    const link = el('a')
    link.href = `#/c/${hit.id}`
    link.addEventListener('click', closeSidebar)
    link.append(el('span', 'search-title', hit.title || 'New chat'))
    if (hit.snippet) link.append(highlight(excerpt(hit.snippet, query), query))
    item.append(link)
    nodes.push(item)
  }
  if (!hits.length && !searching) nodes.push(el('p', 'chat-list-empty', `No chats match “${query}”.`))
  const group = el('div', 'chat-group')
  group.append(...nodes)
  ui.chatList.replaceChildren(group)
}

/** ~90 characters around the first matching word. */
function excerpt(text, query) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const at = Math.min(...words.map((w) => flat.toLowerCase().indexOf(w)).filter((i) => i >= 0), Infinity)
  if (!Number.isFinite(at) || at < 40) return flat.slice(0, 90)
  return `…${flat.slice(at - 30, at + 60)}`
}

/** Wraps the query words in <mark>, built with text nodes (never innerHTML). */
function highlight(text, query) {
  const out = el('span', 'search-snippet')
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) {
    out.textContent = text
    return out
  }
  const splitter = new RegExp(`(${words.join('|')})`, 'gi')
  const lowerWords = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
  for (const piece of text.split(splitter)) {
    if (!piece) continue
    out.append(lowerWords.has(piece.toLowerCase()) ? el('mark', '', piece) : document.createTextNode(piece))
  }
  return out
}

function updateComposer() {
  const streamingHere = Boolean(state.stream) && state.stream.messages === state.messages
  const busy = state.composerFiles.some(isBusy)
  const ready = state.composerFiles.some((item) => item.status === 'ready')
  const label = streamingHere ? 'Stop' : busy ? 'Waiting for your files to upload' : 'Send'
  ui.send.setAttribute('aria-label', label)
  ui.send.title = label
  ui.send.querySelector('use').setAttribute('href', streamingHere ? '#i-stop' : '#i-up')
  ui.send.disabled = !streamingHere && (busy || (!ui.input.value.trim() && !ready))
}

function updateInstructionsChip() {
  const value = state.current ? state.current.system_prompt : state.draftInstructions
  ui.instructionsBtn.classList.toggle('is-set', Boolean(value?.trim()))
}

// ── Files: attaching, showing, downloading ──────────────────────────────────

/** What a sent message keeps about an attached file. */
function sentFile(item) {
  const { id, name, mime, size, kind, storage_path, image_paths, meta, preview } = item
  return { id, name, mime, size, kind, storage_path, image_paths, meta, preview }
}

function addFiles(list) {
  const files = [...(list ?? [])]
  if (!files.length) return
  if (!state.v3) return toast(UPGRADE_V3)
  const room = MAX_FILES - state.composerFiles.length
  if (room <= 0) return toast(`You can attach up to ${MAX_FILES} files per message.`)
  if (files.length > room) toast(`Only ${room} more ${room === 1 ? 'file fits' : 'files fit'} in this message (up to ${MAX_FILES}), so the rest were left out.`)
  for (const file of files.slice(0, room)) {
    const item = {
      key: crypto.randomUUID(),
      name: file.name || 'file',
      size: file.size,
      mime: file.type,
      kind: /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(file.type) ? 'image' : null,
      status: 'reading',
      preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null,
      paths: [],
    }
    state.composerFiles.push(item)
    uploadFile(item, file)
  }
  renderComposerFiles()
}

/** Reads the file here, stores it in your Storage folder, and saves what was read. */
async function uploadFile(item, file) {
  try {
    const result = await withTimeout(readAttachment(file), 120_000, `Reading “${item.name}” took too long. Try a smaller file.`)
    if (item.removed) return
    Object.assign(item, { kind: result.kind, mime: result.mime, meta: result.meta, status: 'uploading' })
    if (result.kind === 'image' && result.images[0] && !item.preview) item.preview = URL.createObjectURL(result.images[0].blob)
    renderComposerFiles()

    const folder = `${state.user.id}/${crypto.randomUUID()}`
    const uploads = []
    const imagePaths = result.images.map((image, i) =>
      `${folder}/${result.kind === 'image' ? '' : `view-${i + 1}-`}${storageName(image.name)}`
    )
    result.images.forEach((image, i) => uploads.push([imagePaths[i], image.blob, image.blob.type || 'image/jpeg']))
    let storagePath = result.kind === 'image' ? imagePaths[0] : null
    if (result.original) {
      storagePath = `${folder}/${storageName(result.name)}`
      uploads.push([storagePath, result.original, result.mime])
    }
    item.paths = uploads.map(([path]) => path)
    for (const [path, blob, contentType] of uploads) {
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false })
      if (error) throw new Error(storageHint(error))
      if (item.removed) return removeStored(item.paths)
    }
    const { data, error } = await supabase.from('chat_attachments').insert({
      name: result.name.slice(0, 255),
      mime: (result.mime || 'application/octet-stream').slice(0, 200),
      size: result.size,
      kind: result.kind,
      storage_path: storagePath,
      image_paths: imagePaths,
      text_content: result.text,
      meta: result.meta,
    }).select('id').single()
    if (error) throw new Error(dbHint(error))
    Object.assign(item, { id: data.id, storage_path: storagePath, image_paths: imagePaths, status: 'ready' })
    if (item.removed) return discardFile(item)
  } catch (err) {
    if (item.removed) return
    console.warn('Could not attach', item.name, err)
    item.status = 'error'
    item.error = err?.message || "This file couldn't be attached."
    removeStored(item.paths)
  }
  renderComposerFiles()
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function removeComposerFile(item) {
  item.removed = true
  state.composerFiles = state.composerFiles.filter((f) => f !== item)
  if (item.preview) URL.revokeObjectURL(item.preview)
  if (item.status === 'ready') discardFile(item)
  renderComposerFiles()
  focusInput()
}

async function discardFile(item) {
  if (item.id) await supabase.from('chat_attachments').delete().eq('id', item.id)
  await removeStored(item.paths)
}

async function removeStored(paths) {
  const unique = [...new Set((paths ?? []).filter(Boolean))]
  for (let i = 0; i < unique.length; i += 100) {
    const { error } = await supabase.storage.from(BUCKET).remove(unique.slice(i, i + 100))
    if (error) console.warn('Could not delete stored files', error)
  }
}

/** Storage paths of every file in the chats matching `filter` (e.g. one chat). */
async function storedPaths(filter) {
  if (!state.v3) return []
  try {
    const rows = await fetchAll(() => filter(supabase.from('chat_attachments').select('conversation_id, storage_path, image_paths')))
    return rows.filter((r) => r.conversation_id).flatMap((r) => [r.storage_path, ...(r.image_paths ?? [])])
  } catch {
    return []
  }
}

/** Files attached to a message that was never sent (tab closed, removed…) are deleted after a day. */
async function cleanUpUnsentFiles() {
  const { data } = await supabase.from('chat_attachments').select('id, storage_path, image_paths')
    .is('message_id', null).lt('created_at', new Date(Date.now() - 86_400_000).toISOString()).limit(100)
  if (!data?.length) return
  await removeStored(data.flatMap((r) => [r.storage_path, ...(r.image_paths ?? [])]))
  await supabase.from('chat_attachments').delete().in('id', data.map((r) => r.id))
}

function storageHint(error) {
  const message = error?.message ?? String(error)
  if (/bucket not found/i.test(message)) return 'Run supabase/upgrade-v3.sql in the SQL Editor first.'
  if (/exceeded the maximum|too large|413/i.test(message)) return 'The file is larger than your Storage limit allows.'
  if (/row-level security|unauthorized|403/i.test(message)) return "Storage didn't allow the upload. Re-run supabase/upgrade-v3.sql."
  return message
}

function renderComposerFiles() {
  ui.composerFiles.hidden = state.composerFiles.length === 0
  ui.composerFiles.replaceChildren(...state.composerFiles.map((item) => {
    const thumb = item.kind === 'image' && item.preview
    const wrap = el('div', `pending-file is-${item.status}${thumb ? ' is-thumb' : ''}`)
    const tile = thumb ? imageThumb(item) : fileCard(item, { status: item })
    if (item.status === 'error') wrap.title = item.error
    const remove = iconButton('i-x', `Remove ${item.name}`)
    remove.classList.add('pending-remove')
    remove.addEventListener('click', () => removeComposerFile(item))
    wrap.append(tile, remove)
    if (isBusy(item)) wrap.append(el('span', 'spinner'))
    return wrap
  }))
  updateComposer()
}

/** Files shown above a message you sent. */
function messageFiles(files) {
  const box = el('div', 'msg-files')
  const images = files.filter((f) => f.kind === 'image')
  const others = files.filter((f) => f.kind !== 'image')
  if (images.length) {
    const row = el('div', `msg-thumbs${images.length === 1 ? ' single' : ''}`)
    for (const file of images) {
      const node = imageThumb(file)
      node.addEventListener('click', () => openLightbox(file))
      row.append(node)
    }
    box.append(row)
  }
  if (others.length) {
    const row = el('div', 'msg-cards')
    for (const file of others) {
      const node = fileCard(file)
      node.addEventListener('click', () => downloadFile(file))
      row.append(node)
    }
    box.append(row)
  }
  return box
}

function imageThumb(file) {
  const node = el(file.id && !file.status ? 'button' : 'span', 'file-thumb')
  if (node.tagName === 'BUTTON') {
    node.type = 'button'
    node.setAttribute('aria-label', `Open ${file.name}`)
  }
  node.title = file.name
  const img = el('img')
  img.alt = file.name
  img.decoding = 'async'
  if (file.preview) img.src = file.preview
  else {
    const path = file.image_paths?.[0] ?? file.storage_path
    if (path) {
      signPath(path).then((url) => {
        if (url) img.src = url
        else node.classList.add('is-broken')
      })
    }
  }
  img.addEventListener('error', () => node.classList.add('is-broken'))
  node.append(img)
  return node
}

const FILE_TONES = [
  ['pdf', /^pdf$/],
  ['doc', /^(docx?|docm|dotx|odt|ott|rtf|pages|txt|md|markdown|epub)$/],
  ['sheet', /^(xlsx?|xlsm|xltx|ods|csv|tsv|numbers)$/],
  ['slides', /^(pptx?|pptm|ppsx|odp|key)$/],
  ['archive', /^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/],
  ['video', /^(mp4|m4v|mov|webm|mkv|avi|ogv|3gp|mpe?g|wmv)$/],
  ['audio', /^(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma|aiff?)$/],
  ['code', /^(js|mjs|cjs|jsx|ts|tsx|py|ipynb|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|swift|dart|lua|r|sql|sh|bash|ps1|html?|css|scss|vue|svelte|json|ya?ml|toml|xml|svg|ini|env|dockerfile|gradle)$/],
]

function fileCard(file, { status } = {}) {
  const ext = extOf(file.name)
  const clickable = !status && file.id
  const card = el(clickable ? 'button' : 'span', 'file-card')
  if (clickable) card.type = 'button'
  const tone = FILE_TONES.find(([, re]) => re.test(ext))?.[0] ?? 'other'
  const badge = el('span', `file-badge tone-${tone}`, (ext || 'file').slice(0, 4).toUpperCase())
  let sub
  if (status?.status === 'reading') sub = 'Reading…'
  else if (status?.status === 'uploading') sub = 'Uploading…'
  else if (status?.status === 'error') sub = status.error
  else {
    const label = file.kind ? typeLabel(file) : (ext || 'file').toUpperCase()
    sub = file.kind === 'file' ? `${label} · name only` : `${label} · ${formatSize(file.size)}`
  }
  const text = el('span', 'file-text')
  text.append(el('span', 'file-name', file.name), el('span', 'file-sub', sub))
  card.append(badge, text)
  if (file.kind === 'file') card.classList.add('is-unreadable')
  const note = typeof file.meta?.note === 'string' ? file.meta.note : ''
  card.title = status?.status === 'error'
    ? status.error
    : [file.name, note, clickable ? 'Click to download.' : ''].filter(Boolean).join('\n')
  if (clickable) card.setAttribute('aria-label', `Download ${file.name}`)
  return card
}

// Private files are shown through short-lived signed links, fetched in batches.
const signedUrls = new Map() // path → { url, until }
let signBatch = null

function signPath(path) {
  const hit = signedUrls.get(path)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url)
  if (!signBatch) {
    signBatch = new Map()
    setTimeout(flushSigns, 0)
  }
  if (!signBatch.has(path)) {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    signBatch.set(path, { promise, resolve })
  }
  return signBatch.get(path).promise
}

async function flushSigns() {
  const batch = signBatch
  signBatch = null
  const paths = [...batch.keys()]
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
  for (const path of paths) {
    const row = data?.find((r) => r.path === path)
    const url = !error && row?.signedUrl && !row.error ? row.signedUrl : null
    if (url) signedUrls.set(path, { url, until: Date.now() + 50 * 60_000 })
    batch.get(path).resolve(url)
  }
}

async function downloadFile(file) {
  if (!file.storage_path) {
    return toast(file.meta?.notStored
      ? 'Only the text of this file was kept: the file itself was over 25 MB, too large to store.'
      : "This file isn't stored, so it can't be downloaded.")
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(file.storage_path, 60, { download: file.name })
  if (error) return toast(`Couldn't download “${file.name}”. ${storageHint(error)}`)
  const link = Object.assign(document.createElement('a'), { href: data.signedUrl, rel: 'noopener' })
  document.body.append(link)
  link.click()
  link.remove()
}

function openLightbox(file) {
  const path = file.image_paths?.[0] ?? file.storage_path
  ui.lightboxName.textContent = file.name
  ui.lightboxImg.alt = file.name
  ui.lightboxImg.removeAttribute('src')
  if (file.preview) ui.lightboxImg.src = file.preview
  else if (path) signPath(path).then((url) => url && (ui.lightboxImg.src = url))
  ui.lightboxDownload.onclick = () => downloadFile(file)
  ui.lightboxDownload.hidden = !file.storage_path
  ui.lightbox.showModal()
}

ui.lightboxClose.addEventListener('click', () => ui.lightbox.close())
ui.lightbox.addEventListener('click', (event) => {
  if (event.target === ui.lightbox || event.target.classList.contains('lightbox-stage')) ui.lightbox.close()
})

ui.attachBtn.addEventListener('click', () => {
  if (!state.v3) return toast(UPGRADE_V3)
  ui.fileInput.click()
})
ui.fileInput.addEventListener('change', () => {
  addFiles(ui.fileInput.files)
  ui.fileInput.value = ''
})

// Pasting a screenshot or a copied file attaches it. (Text copied from Word or a
// web page also carries a picture of itself; that pastes as text, as expected.)
ui.input.addEventListener('paste', (event) => {
  const data = event.clipboardData
  if (!data?.files?.length) return
  if (data.types.includes('text/plain') && data.getData('text/plain').trim()) return
  event.preventDefault()
  addFiles(data.files)
})

// Drag & drop anywhere on the chat
const dragHasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files')
let dragDepth = 0
ui.main.addEventListener('dragenter', (event) => {
  if (!dragHasFiles(event) || !state.user) return
  event.preventDefault()
  dragDepth++
  ui.main.classList.add('is-dragging')
})
ui.main.addEventListener('dragover', (event) => {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})
ui.main.addEventListener('dragleave', (event) => {
  if (!dragHasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) ui.main.classList.remove('is-dragging')
})
ui.main.addEventListener('drop', (event) => {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  ui.main.classList.remove('is-dragging')
  addFiles(event.dataTransfer.files)
})
// A file dropped next to the chat shouldn't make the browser leave the app to open it.
window.addEventListener('dragover', (event) => dragHasFiles(event) && event.preventDefault())
window.addEventListener('drop', (event) => dragHasFiles(event) && event.preventDefault())

// ── Chat actions ─────────────────────────────────────────────────────────────

async function deleteChat(conversation) {
  if (!confirm(`Delete "${conversation.title}"? This can't be undone.`)) return
  if (state.stream?.conversationId === conversation.id) state.stream.controller.abort()
  const files = await storedPaths((q) => q.eq('conversation_id', conversation.id))
  const { error } = await supabase.from('chat_conversations').delete().eq('id', conversation.id)
  if (error) return toast(`Couldn't delete the chat. ${dbHint(error)}`)
  removeStored(files)
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

// ── Settings ─────────────────────────────────────────────────────────────────

let settingsPane = 'general'

function openSettings(pane = 'general') {
  closeSidebar()
  ui.settingsUpgrade.hidden = state.v2
  ui.settingsDialog.querySelectorAll('[data-v2]').forEach((node) => (node.disabled = !state.v2))
  ui.customInstructions.value = state.customInstructions
  ui.settingsEmail.textContent = state.user?.email ?? ''
  syncThemeControl()
  ui.setNotify.checked = notificationsOn()
  ui.setArtifacts.checked = state.prefs.artifacts !== false
  ui.setMemory.checked = state.prefs.memory !== false
  ui.setReference.checked = state.prefs.referenceChats === true
  ui.setBudget.value = state.prefs.monthlyBudget ?? ''
  ui.memorySubmit.disabled = !state.v2 || !ui.memoryInstruction.value.trim()
  if (!ui.settingsDialog.open) ui.settingsDialog.showModal()
  showPane(pane)
}

function showPane(pane) {
  settingsPane = pane
  for (const tab of ui.settingsDialog.querySelectorAll('.settings-tab')) {
    const on = tab.dataset.pane === pane
    tab.classList.toggle('active', on)
    if (on) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
  for (const section of ui.settingsDialog.querySelectorAll('.settings-pane')) {
    section.hidden = section.dataset.pane !== pane
  }
  ui.settingsDialog.querySelector('.settings-main').scrollTop = 0
  if (pane === 'usage') loadUsage()
  if (pane === 'memory') loadMemories()
}

ui.account.addEventListener('click', () => openSettings('general'))
ui.settingsClose.addEventListener('click', () => ui.settingsDialog.close())
ui.settingsDialog.addEventListener('click', (event) => {
  if (event.target === ui.settingsDialog) ui.settingsDialog.close() // click on the backdrop
})
for (const tab of ui.settingsDialog.querySelectorAll('.settings-tab')) {
  tab.addEventListener('click', () => showPane(tab.dataset.pane))
}

// General → theme (this device only)
let themeChoice = ['light', 'dark'].includes(store.get('chat.theme')) ? store.get('chat.theme') : 'system'

function applyTheme(value) {
  themeChoice = value
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value
  else delete document.documentElement.dataset.theme
  store.set('chat.theme', value)
  syncThemeControl()
}

function syncThemeControl() {
  for (const button of ui.themeControl.querySelectorAll('[data-theme-value]')) {
    button.setAttribute('aria-checked', String(button.dataset.themeValue === themeChoice))
  }
}

ui.themeControl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme-value]')
  if (button) applyTheme(button.dataset.themeValue)
})

// General → notifications (this device only)
function notificationsOn() {
  return store.get('chat.notify') === '1' && 'Notification' in window && Notification.permission === 'granted'
}

ui.setNotify.addEventListener('change', async () => {
  if (!ui.setNotify.checked) return store.set('chat.notify', '0')
  if (!('Notification' in window)) {
    ui.setNotify.checked = false
    return toast("This browser doesn't support notifications.")
  }
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission !== 'granted') {
    ui.setNotify.checked = false
    store.set('chat.notify', '0')
    return toast('Notifications are blocked for this site. Allow them in your browser settings, then try again.')
  }
  store.set('chat.notify', '1')
  toast("You'll get a notification when a reply finishes in the background.")
})

function notifyReply(reply) {
  if (!document.hidden || !notificationsOn()) return
  try {
    const body = plainText(reply.content).replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
    const notification = new Notification(`${APP_NAME}: reply ready`, { body, tag: 'chat-reply' })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

// General → instructions for every chat
ui.saveInstructions.addEventListener('click', async () => {
  const value = ui.customInstructions.value.trim()
  ui.saveInstructions.disabled = true
  const { error } = await supabase
    .from('chat_settings')
    .upsert({ user_id: state.user.id, custom_instructions: value, updated_at: new Date().toISOString() })
  ui.saveInstructions.disabled = false
  if (error) return toast(`Couldn't save your instructions. ${dbHint(error)}`)
  state.customInstructions = value
  toast('Instructions saved. They apply from your next message.')
})

// Capabilities & Memory switches (saved to Supabase, so they follow you across devices)
function bindPreference(input, key, onMessage, offMessage) {
  input.addEventListener('change', async () => {
    const value = input.checked
    input.disabled = true
    const ok = await savePrefs({ [key]: value })
    input.disabled = false
    if (!ok) input.checked = !value
    else toast(value ? onMessage : offMessage)
  })
}
bindPreference(ui.setArtifacts, 'artifacts', 'Artifacts on. They apply from your next message.', 'Artifacts off. Code will appear in replies as plain text.')
bindPreference(ui.setReference, 'referenceChats', 'The model can now look up your past chats.', "The model won't look up your past chats.")
bindPreference(ui.setMemory, 'memory', 'Memory on. The model will save and use facts about you.', 'Memory off. Saved memories stay until you delete them.')

// Usage
let usageRows = null
let usageLoadedAt = null

async function loadUsage() {
  if (!state.v2) return renderUsage()
  const now = new Date()
  const since = new Date(now.getFullYear(), now.getMonth(), 1)
  ui.usageUpdated.textContent = 'Loading…'
  const { data, error } = await supabase.rpc('chat_usage', {
    since: since.toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  if (error) {
    ui.usageUpdated.textContent = '—'
    return toast(`Couldn't load usage. ${dbHint(error)}`)
  }
  usageRows = data ?? []
  usageLoadedAt = new Date()
  renderUsage()
}

function renderUsage() {
  const now = new Date()
  const todayKey = dateKey(now)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const blank = () => ({ tokens: 0, cost: 0, replies: 0, estimated: false, unpriced: false })
  const month = blank()
  const today = blank()
  const models = new Map()
  const days = new Map()

  for (const row of usageRows ?? []) {
    const tokens = Number(row.prompt_tokens) + Number(row.completion_tokens)
    const price = MODELS.find((m) => m.id === row.model)?.price
    const priced = typeof price === 'number'
    const cost = priced ? (tokens * price) / 1_000_000 : 0
    if (!models.has(row.model)) models.set(row.model, blank())
    const targets = [month, models.get(row.model)]
    const dayKey = String(row.day).slice(0, 10) // 'YYYY-MM-DD'
    if (dayKey === todayKey) targets.push(today)
    for (const t of targets) {
      t.tokens += tokens
      t.cost += cost
      t.replies += Number(row.replies)
      t.estimated ||= Boolean(row.estimated)
      t.unpriced ||= !priced
    }
    const day = days.get(dayKey) ?? { cost: 0, tokens: 0 }
    day.cost += cost
    day.tokens += tokens
    days.set(dayKey, day)
  }

  const approx = (t) => (t.estimated ? '≈ ' : '')
  ui.usageReset.textContent = `Resets on ${nextMonth.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`
  ui.usageMonthCost.textContent = `${approx(month)}${rupiah(month.cost)}`
  ui.usageMonthTokens.textContent = `${formatTokens(month.tokens)} tokens · ${month.replies} ${month.replies === 1 ? 'reply' : 'replies'}`
  ui.usageTodayCost.textContent = `${approx(today)}${rupiah(today.cost)}`
  ui.usageTodayTokens.textContent = `${formatTokens(today.tokens)} tokens`
  ui.usageTodayReplies.textContent = `${today.replies} ${today.replies === 1 ? 'reply' : 'replies'} so far`

  const budget = Number(state.prefs.monthlyBudget) || 0
  ui.usageMeter.hidden = budget <= 0
  ui.usageMeter.classList.remove('warn', 'over')
  if (budget > 0) {
    const share = month.cost / budget
    ui.usageMeterFill.style.width = `${Math.min(100, share * 100)}%`
    if (share >= 1) ui.usageMeter.classList.add('over')
    else if (share >= 0.8) ui.usageMeter.classList.add('warn')
    ui.usageMeterLabel.textContent = `${Math.round(share * 100)}% of your ${rupiah(budget)} budget used${
      share >= 1 ? '. You are over budget this month.' : ''
    }`
  } else {
    ui.usageMeterLabel.textContent = 'Set a monthly budget below to see how much of it you have used.'
  }

  // Daily bars for this month (cost, or tokens if no model has a price)
  const byCost = month.cost > 0
  const values = Array.from({ length: daysInMonth }, (_, i) => {
    const key = dateKey(new Date(now.getFullYear(), now.getMonth(), i + 1))
    const d = days.get(key)
    return d ? (byCost ? d.cost : d.tokens) : 0
  })
  const max = Math.max(...values, 0)
  ui.usageChart.replaceChildren(...values.map((value, i) => {
    const bar = el('span', `bar${i + 1 === now.getDate() ? ' today' : ''}${i + 1 > now.getDate() ? ' future' : ''}`)
    bar.style.height = `${max > 0 && value > 0 ? Math.max(6, (value / max) * 100) : 3}%`
    bar.title = `${i + 1} ${now.toLocaleDateString('en-GB', { month: 'short' })}: ${
      byCost ? rupiah(value) : `${formatTokens(value)} tokens`
    }`
    return bar
  }))

  const rows = [...models.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
  ui.usageModels.replaceChildren(...(rows.length
    ? rows.map(([id, t]) => {
      const tr = el('tr')
      tr.append(
        el('td', '', modelLabel(id)),
        el('td', 'num', String(t.replies)),
        el('td', 'num', `${approx(t)}${formatTokens(t.tokens)}`),
        el('td', 'num', t.unpriced && t.cost === 0 ? '—' : `${approx(t)}${rupiah(t.cost)}`),
      )
      return tr
    })
    : [(() => {
      const tr = el('tr')
      const td = el('td', 'empty', state.v2 ? 'No replies yet this month.' : 'Usage needs the database update above.')
      td.colSpan = 4
      tr.append(td)
      return tr
    })()]))
  ui.usageUpdated.textContent = usageLoadedAt
    ? usageLoadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—'
}

ui.usageRefresh.addEventListener('click', loadUsage)
ui.setBudget.addEventListener('change', async () => {
  const raw = ui.setBudget.value.trim()
  const value = raw === '' ? null : Math.max(0, Math.round(Number(raw)))
  if (value !== null && !Number.isFinite(value)) return
  if (await savePrefs({ monthlyBudget: value })) {
    renderUsage()
    toast(value ? `Monthly budget set to ${rupiah(value)}.` : 'Monthly budget removed.')
  }
})

// Memory
async function loadMemories() {
  if (!state.v2) return renderMemories()
  const { data, error } = await supabase
    .from('chat_memories')
    .select('id, content, created_at')
    .order('created_at', { ascending: false })
  if (error) return toast(`Couldn't load memory. ${dbHint(error)}`)
  state.memories = data
  renderMemories()
}

function renderMemories() {
  const list = state.memories
  ui.memoryCount.textContent = list.length ? `${list.length} saved` : ''
  if (!state.v2) {
    ui.memoryList.replaceChildren(el('li', 'memory-empty', 'Memory needs the database update above.'))
  } else if (!list.length) {
    ui.memoryList.replaceChildren(el(
      'li',
      'memory-empty',
      'Nothing saved yet. Mention something about yourself in a chat, or type it below, e.g. "Remember that I work in Jakarta."',
    ))
  } else {
    ui.memoryList.replaceChildren(...list.map(memoryItem))
  }
}

function memoryItem(memory) {
  const item = el('li', 'memory-item')
  const edit = iconButton('i-edit', 'Edit memory')
  const remove = iconButton('i-trash', 'Delete memory')
  edit.addEventListener('click', () => editMemory(item, memory))
  remove.addEventListener('click', () => deleteMemory(memory))
  const actions = el('span', 'memory-actions')
  actions.append(edit, remove)
  item.append(el('span', 'memory-text', memory.content), actions)
  return item
}

function editMemory(item, memory) {
  const input = el('input', 'memory-input')
  input.value = memory.content
  input.maxLength = 500
  input.setAttribute('aria-label', 'Edit memory')
  item.replaceChildren(input)
  input.focus()
  let done = false
  const finish = async (save) => {
    if (done) return
    done = true
    const value = input.value.replace(/\s+/g, ' ').trim()
    if (save && value && value !== memory.content) {
      const { error } = await supabase
        .from('chat_memories')
        .update({ content: value, updated_at: new Date().toISOString() })
        .eq('id', memory.id)
      if (error) toast(`Couldn't save that memory. ${dbHint(error)}`)
      else memory.content = value
    }
    renderMemories()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault() // keep the dialog open
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
}

async function deleteMemory(memory) {
  const { error } = await supabase.from('chat_memories').delete().eq('id', memory.id)
  if (error) return toast(`Couldn't delete that memory. ${dbHint(error)}`)
  state.memories = state.memories.filter((m) => m.id !== memory.id)
  renderMemories()
}

ui.memoryInstruction.addEventListener('input', () => {
  ui.memorySubmit.disabled = !state.v2 || !ui.memoryInstruction.value.trim()
})

ui.memoryForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const instruction = ui.memoryInstruction.value.trim()
  if (!instruction || !state.v2) return
  ui.memoryForm.classList.add('is-busy')
  ui.memoryInstruction.disabled = true
  ui.memorySubmit.disabled = true
  try {
    const res = await callFunction({ action: 'memory_edit', instruction, model: ui.model.value })
    if (!res.ok) throw new Error(await responseError(res))
    const result = await res.json()
    state.memories = [...(result.memories ?? [])].reverse() // newest first
    renderMemories()
    ui.memoryInstruction.value = ''
    toast(memorySummary(result))
  } catch (err) {
    toast(friendlyError(err))
  } finally {
    ui.memoryForm.classList.remove('is-busy')
    ui.memoryInstruction.disabled = false
    ui.memorySubmit.disabled = !ui.memoryInstruction.value.trim()
    ui.memoryInstruction.focus()
  }
})

function memorySummary({ added = 0, updated = 0, deleted = 0 }) {
  const parts = []
  if (added) parts.push(`${added} added`)
  if (updated) parts.push(`${updated} updated`)
  if (deleted) parts.push(`${deleted} removed`)
  return parts.length ? `Memory updated: ${parts.join(', ')}.` : 'No changes were needed.'
}

function onMemoryUpdated(changes) {
  toast(changes === 1 ? 'Memory updated.' : `Memory updated (${changes} changes).`)
  if (ui.settingsDialog.open && settingsPane === 'memory') loadMemories()
}

ui.memoryClear.addEventListener('click', async () => {
  if (!state.memories.length) await loadMemories()
  if (!state.memories.length) return toast('There are no memories to delete.')
  if (!confirm("Delete everything the model remembers about you? This can't be undone.")) return
  const { error } = await supabase.from('chat_memories').delete().eq('user_id', state.user.id)
  if (error) return toast(`Couldn't delete your memories. ${dbHint(error)}`)
  state.memories = []
  renderMemories()
  toast('All memories deleted.')
})

// Account
ui.signOut.addEventListener('click', async () => {
  ui.settingsDialog.close()
  await supabase.auth.signOut()
})

ui.exportData.addEventListener('click', async () => {
  ui.exportData.disabled = true
  try {
    const [conversations, messages, files] = await Promise.all([
      fetchAll(() =>
        supabase.from('chat_conversations').select('id, title, model, system_prompt, created_at, updated_at')
          .order('created_at', { ascending: true })
      ),
      fetchAll(() =>
        supabase.from('chat_messages')
          .select(`id, conversation_id, role, content, model, finish_reason, prompt_tokens, completion_tokens, created_at${
            state.v3 ? ', parent_id' : ''
          }`)
          .order('created_at', { ascending: true })
      ),
      state.v3
        ? fetchAll(() =>
          supabase.from('chat_attachments').select('message_id, name, mime, size, kind').not('message_id', 'is', null)
            .order('created_at', { ascending: true })
        )
        : [],
    ])
    const filesOf = new Map()
    for (const { message_id: id, ...file } of files) {
      if (!filesOf.has(id)) filesOf.set(id, [])
      filesOf.get(id).push(file)
    }
    for (const message of messages) if (filesOf.has(message.id)) message.attachments = filesOf.get(message.id)
    const memories = state.v2
      ? (await supabase.from('chat_memories').select('content, created_at').order('created_at', { ascending: true })).data ?? []
      : []
    const chats = new Map(conversations.map((c) => [c.id, { ...c, messages: [] }]))
    for (const { conversation_id: id, ...message } of messages) chats.get(id)?.messages.push(message)
    const payload = {
      app: APP_NAME,
      exported_at: new Date().toISOString(),
      account: state.user.email,
      settings: { custom_instructions: state.customInstructions, preferences: state.prefs },
      memories,
      conversations: [...chats.values()],
    }
    saveFile(`${APP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-export-${dateKey(new Date())}.json`, JSON.stringify(payload, null, 2))
    toast(`Exported ${conversations.length} ${conversations.length === 1 ? 'chat' : 'chats'}.`)
  } catch (err) {
    toast(`Couldn't export your data. ${err?.message ?? err}`)
  } finally {
    ui.exportData.disabled = false
  }
})

ui.deleteAll.addEventListener('click', async () => {
  if (!confirm("Delete all chats and their messages? This can't be undone.")) return
  state.stream?.controller.abort()
  const files = await storedPaths((q) => q)
  const { error } = await supabase.from('chat_conversations').delete().eq('user_id', state.user.id)
  if (error) return toast(`Couldn't delete your chats. ${dbHint(error)}`)
  removeStored(files)
  state.conversations = []
  ui.settingsDialog.close()
  renderSidebar()
  goToNewChat()
  toast('All chats deleted.')
})

/** Reads every row, 1,000 at a time (Supabase returns at most 1,000 per request). */
async function fetchAll(build) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(dbHint(error))
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

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
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return
  if (ui.app.classList.contains('sidebar-open')) closeSidebar()
  else if (artifactPanel.openId) artifactPanel.close()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function dateKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Rupiah, with cents only for tiny amounts (a single reply often costs less than Rp 1). */
function rupiah(value) {
  const digits = value > 0 && value < 100 ? 2 : 0
  return `Rp ${value.toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  return n.toLocaleString('en-US')
}

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
