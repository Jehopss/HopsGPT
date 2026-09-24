// Artifacts: pulls <artifact> blocks out of replies and shows them in a side panel.
// Previews run in a sandboxed iframe with an opaque origin, so an artifact's code
// can't read your session, your chats or this page.

const ARTIFACT_RE = /<artifact\b([^>]*)>([\s\S]*?)(?:<\/artifact>|$)/g
const PARTIAL_TAG_RE = /<(?:a(?:r(?:t(?:i(?:f(?:a(?:c(?:t\b[^>]*)?)?)?)?)?)?)?)?$/
const TYPE_LABELS = { html: 'HTML', svg: 'SVG', markdown: 'Document' }
const EXTENSIONS = { html: 'html', svg: 'svg', markdown: 'md' }
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads'

/** Splits a reply into text and artifact parts. While streaming, a half-written tag is hidden. */
export function splitReply(text, streaming = false) {
  const parts = []
  let last = 0
  for (const match of text.matchAll(ARTIFACT_RE)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) })
    const attrs = parseAttributes(match[1])
    const content = tidy(match[2])
    parts.push({
      kind: 'artifact',
      id: attrs.id || `artifact-${parts.length + 1}`,
      type: normalizeType(attrs.type, content),
      title: attrs.title || 'Untitled',
      content,
      complete: match[0].endsWith('</artifact>'),
    })
    last = match.index + match[0].length
  }
  let tail = text.slice(last)
  if (streaming) tail = tail.replace(PARTIAL_TAG_RE, '')
  if (tail) parts.push({ kind: 'text', text: tail })
  return parts
}

/** Every version of every artifact in a chat, in order: Map(id → [{...artifact, messageIndex}]). */
export function collectArtifacts(messages) {
  const byId = new Map()
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || !message.content) return
    for (const part of splitReply(message.content, message.pending)) {
      if (part.kind !== 'artifact') continue
      if (!byId.has(part.id)) byId.set(part.id, [])
      byId.get(part.id).push({ ...part, messageIndex })
    }
  })
  return byId
}

/** Reply text with artifact tags replaced by their content (for "Copy reply"). */
export function plainText(text) {
  return splitReply(text).map((p) => (p.kind === 'text' ? p.text : `\n${p.content}\n`)).join('').trim()
}

/** The card shown in the chat where an artifact appears. */
export function artifactCard(part, version, onOpen) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = `artifact-card${part.complete ? '' : ' is-writing'}`
  card.dataset.artifactId = part.id
  const icon = part.type === 'svg' ? 'i-image' : part.type === 'markdown' ? 'i-file' : 'i-code'
  card.innerHTML = `<span class="artifact-card-icon"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></span>
    <span class="artifact-card-text"><span class="artifact-card-title"></span><span class="artifact-card-meta"></span></span>
    <svg class="icon artifact-card-chevron" aria-hidden="true"><use href="#i-chevron-right"/></svg>`
  card.querySelector('.artifact-card-title').textContent = part.title
  card.querySelector('.artifact-card-meta').textContent = part.complete
    ? `${TYPE_LABELS[part.type]}${version > 1 ? ` · v${version}` : ''}`
    : 'Writing…'
  card.setAttribute('aria-label', `Open ${part.title}`)
  card.addEventListener('click', () => onOpen(part.id, version - 1))
  return card
}

/**
 * The side panel. `els` holds its DOM nodes; `renderMarkdown(el, text)` renders documents.
 * Call update(messages) whenever the chat changes (also while streaming).
 */
export function createArtifactPanel({ els, renderMarkdown, onOpenChange }) {
  let state = null // { id, index, follow, tab }
  let versions = []
  let shownKey = ''

  const current = () => versions[state.index]

  function open(id, index, { tab = 'preview', focus = true } = {}) {
    const follow = index === undefined || index === null
    state = { id, index: 0, follow, tab }
    shownKey = ''
    els.root.hidden = false
    onOpenChange(true)
    update(lastMessages, index)
    if (focus) els.close.focus({ preventScroll: true })
  }

  function close() {
    if (!state) return
    state = null
    shownKey = ''
    els.root.hidden = true
    els.body.replaceChildren()
    onOpenChange(false)
  }

  let lastMessages = []
  function update(messages, index) {
    lastMessages = messages
    if (!state) return
    versions = collectArtifacts(messages).get(state.id) ?? []
    if (versions.length === 0) return close()
    if (index !== undefined && index !== null) state.index = Math.min(index, versions.length - 1)
    else if (state.follow) state.index = versions.length - 1
    state.index = Math.min(state.index, versions.length - 1)
    render()
  }

  function setTab(tab) {
    if (!state) return
    state.tab = tab
    shownKey = ''
    render()
  }

  function render() {
    const artifact = current()
    els.title.textContent = artifact.title
    els.meta.textContent = artifact.complete ? TYPE_LABELS[artifact.type] : 'Writing…'
    els.version.textContent = `v${state.index + 1} of ${versions.length}`
    els.versions.hidden = versions.length < 2
    els.prev.disabled = state.index === 0
    els.next.disabled = state.index === versions.length - 1
    // Unfinished HTML/SVG can't be previewed yet, so show its code as it streams.
    const tab = !artifact.complete && artifact.type !== 'markdown' ? 'code' : state.tab
    els.tabPreview.setAttribute('aria-selected', String(tab === 'preview'))
    els.tabCode.setAttribute('aria-selected', String(tab === 'code'))

    const key = `${state.id}|${state.index}|${tab}|${artifact.complete}`
    if (tab === 'code') {
      if (key !== shownKey) {
        const pre = document.createElement('pre')
        pre.className = 'ap-code'
        pre.append(document.createElement('code'))
        els.body.replaceChildren(pre)
      }
      els.body.querySelector('code').textContent = artifact.content
    } else if (artifact.type === 'markdown') {
      if (key !== shownKey || !artifact.complete) {
        const doc = document.createElement('div')
        doc.className = 'md ap-doc'
        renderMarkdown(doc, artifact.content)
        els.body.replaceChildren(doc)
      }
    } else if (key !== shownKey) {
      const frame = document.createElement('iframe')
      frame.className = 'ap-frame'
      frame.title = artifact.title
      frame.setAttribute('sandbox', SANDBOX)
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.srcdoc = artifact.type === 'svg' ? svgDocument(artifact.content) : artifact.content
      els.body.replaceChildren(frame)
    }
    shownKey = key
  }

  els.close.addEventListener('click', close)
  els.tabPreview.addEventListener('click', () => setTab('preview'))
  els.tabCode.addEventListener('click', () => setTab('code'))
  els.prev.addEventListener('click', () => {
    state.index = Math.max(0, state.index - 1)
    state.follow = false
    render()
  })
  els.next.addEventListener('click', () => {
    state.index = Math.min(versions.length - 1, state.index + 1)
    state.follow = state.index === versions.length - 1
    render()
  })
  els.download.addEventListener('click', () => {
    const artifact = current()
    const type = artifact.type === 'html' ? 'text/html' : artifact.type === 'svg' ? 'image/svg+xml' : 'text/markdown'
    const url = URL.createObjectURL(new Blob([artifact.content], { type: `${type};charset=utf-8` }))
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: `${artifact.id}.${EXTENSIONS[artifact.type]}`,
    })
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  return {
    open,
    close,
    update,
    get openId() {
      return state?.id ?? null
    },
    copyText: () => current()?.content ?? '',
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseAttributes(source) {
  const attrs = {}
  for (const m of source.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2]
  return attrs
}

function normalizeType(type, content) {
  const t = (type || '').toLowerCase()
  if (t === 'html' || t === 'svg') return t
  if (t === 'markdown' || t === 'md' || t === 'text' || t === 'document') return 'markdown'
  if (/^<svg[\s>]/i.test(content)) return 'svg'
  if (/^<!doctype html|^<html[\s>]/i.test(content)) return 'html'
  return 'markdown'
}

/** Trims blank lines and removes code fences a model may have added around the content. */
function tidy(content) {
  let text = content.replace(/^\s*\n/, '').replace(/\s+$/, '')
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1]
  return text
}

function svgDocument(svg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#fff}
body{display:grid;place-items:center;padding:24px;box-sizing:border-box}
svg{max-width:100%;max-height:100%;height:auto}
</style></head><body>${svg}</body></html>`
}
