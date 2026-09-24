// Reads attached files in the browser, so the model gets something it understands:
//  - images            → resized picture (the model looks at it)
//  - PDF               → text of every page; scanned PDFs → pictures of the first pages
//  - Word, Excel, PowerPoint, OpenDocument, EPUB → their text (tables as rows)
//  - ZIP               → list of files + the text files inside
//  - video             → frames spread over the clip (the model looks at them)
//  - anything readable as text (code, CSV, JSON, Markdown, logs, SVG, …) → as is
//  - everything else (audio, apps, …) → stored and shown, the model only learns its name and type
// Heavy libraries (pdf.js, fflate) load only when a file needs them.

export const MAX_STORED_BYTES = 25 * 1024 * 1024 // matches the bucket limit in upgrade-v3.sql
const MAX_READ_BYTES = 250 * 1024 * 1024 // bigger files are read here, but only what was read is kept
export const MAX_FILES = 10
const MAX_TEXT = 1_000_000 // characters kept per file (database limit)
const MAX_IMAGE_SIDE = 2048
const KEEP_IMAGE_BYTES = 3 * 1024 * 1024
const SCANNED_PAGES = 10
const VIDEO_FRAMES = 8
const VIDEO_SIDE = 768

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/legacy/build/pdf.min.mjs'
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/legacy/build/pdf.worker.min.mjs'
const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js'

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp', 'mpeg', 'mpg', 'wmv'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif'])
const OFFICE = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx', potx: 'pptx', potm: 'pptx',
  odt: 'odf', ott: 'odf', ods: 'odf', ots: 'odf', odp: 'odf', otp: 'odf', odg: 'odf',
  epub: 'epub',
}
const LEGACY_OFFICE = { doc: 'Word 97–2003', xls: 'Excel 97–2003', ppt: 'PowerPoint 97–2003' }
const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', zip: 'application/zip', epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
}
const ZIP_SKIP = /(^|\/)(node_modules|\.git|__MACOSX|\.venv|venv|__pycache__|dist|build|\.next|vendor)\//

export const extOf = (name) => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] ?? '').toLowerCase()

/**
 * Reads one file. Returns
 * { kind: 'image'|'document'|'file', name, mime, size, original: Blob|null,
 *   images: [{ blob, name }], text: string|null, meta: {} }
 * `original` is stored as the downloadable file; `images` are what the model looks at.
 */
export async function readAttachment(file) {
  const result = await read(file)
  if (result.original && result.original.size > MAX_STORED_BYTES) {
    if (result.kind === 'file') {
      throw new Error(`“${result.name}” is larger than 25 MB, and its contents can't be read here, so it can't be attached.`)
    }
    result.original = null // too big to store: keep what was read, not the file itself
    result.meta = { ...result.meta, notStored: true }
  }
  return result
}

async function read(file) {
  const name = file.name || 'file'
  const ext = extOf(name)
  const mime = file.type || MIME_BY_EXT[ext] || 'application/octet-stream'
  const base = { name, mime, size: file.size, original: file, images: [], text: null, meta: {} }
  if (file.size > MAX_READ_BYTES) throw new Error(`“${name}” is larger than 250 MB, so it can't be attached.`)

  if (ext === 'svg' || mime === 'image/svg+xml') {
    const text = await file.text()
    const png = await rasterize(file, 'image/png').catch(() => null)
    return withText({ ...base, kind: 'document', images: png ? [{ blob: png, name: 'preview.png' }] : [] }, text)
  }
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) {
    const image = await prepareImage(file).catch(() => null)
    if (!image) {
      return fileOnly(base, `An image in a format the model can't see (${ext.toUpperCase() || mime}). Converting it to PNG or JPG would let the model see it.`)
    }
    return { ...base, kind: 'image', original: null, images: [{ blob: image.blob, name: image.name }], meta: { width: image.width, height: image.height } }
  }
  if (ext === 'pdf' || mime === 'application/pdf') return readPdf(file, base)
  if (OFFICE[ext]) {
    try {
      const { text, meta } = await readZipDocument(OFFICE[ext], await file.arrayBuffer())
      if (text.trim()) return withText({ ...base, kind: 'document', meta }, text)
      return fileOnly(base, 'This document has no readable text.')
    } catch (err) {
      console.warn('Could not read', name, err)
      return fileOnly(base, `The file couldn't be read${err?.message ? ` (${err.message})` : ''}.`)
    }
  }
  if (LEGACY_OFFICE[ext]) {
    return fileOnly(base, `An old ${LEGACY_OFFICE[ext]} file, which can't be read here. Saving it as .${ext}x first would let the model read it.`)
  }
  if (ext === 'zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
    try {
      return withText({ ...base, kind: 'document' }, await readZipArchive(await file.arrayBuffer()))
    } catch {
      return fileOnly(base, "A ZIP archive that couldn't be opened.")
    }
  }
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return readVideo(file, base)
  if (mime.startsWith('audio/')) {
    return fileOnly(base, "An audio file. The model can't listen to it here; only its name, type and size are known.")
  }
  const text = decodeText(new Uint8Array(await file.arrayBuffer()))
  if (text !== null) return withText({ ...base, kind: 'document', mime: file.type || MIME_BY_EXT[ext] || 'text/plain' }, text)
  return fileOnly(base, "A binary file. Its contents can't be read here; only its name, type and size are known.")
}

function withText(result, text) {
  const clean = text.replaceAll('\u0000', '').replace(/\r\n?/g, '\n')
  if (clean.length <= MAX_TEXT) return { ...result, text: clean }
  return {
    ...result,
    text: `${clean.slice(0, MAX_TEXT - 200)}\n\n[File cut off here: it has ${clean.length.toLocaleString('en')} characters, and only the first ${(MAX_TEXT - 200).toLocaleString('en')} are kept.]`,
    meta: { ...result.meta, truncated: true },
  }
}

function fileOnly(base, note) {
  return { ...base, kind: 'file', meta: { ...base.meta, note } }
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** UTF-8 / UTF-16 / Windows-1252 text, or null when the bytes look binary. */
export function decodeText(bytes) {
  if (bytes.length === 0) return ''
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  const sample = bytes.subarray(0, 8192)
  if (sample.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { /* not UTF-8 */ }
  let control = 0
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) control++
  return control / sample.length < 0.01 ? new TextDecoder('windows-1252').decode(bytes) : null
}

// ── Images ───────────────────────────────────────────────────────────────────

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  const keep = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) &&
    Math.max(width, height) <= MAX_IMAGE_SIDE && file.size <= KEEP_IMAGE_BYTES
  if (keep) {
    bitmap.close?.()
    return { blob: file, name: file.name, width, height }
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const png = file.type === 'image/png' && w * h <= 1_500_000 // keep screenshots crisp
  if (!png) {
    ctx.fillStyle = '#fff' // JPEG has no transparency
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const blob = await canvasBlob(canvas, png ? 'image/png' : 'image/jpeg', 0.88)
  const base = file.name.replace(/\.[^.]+$/, '') || 'image'
  return { blob, name: `${base}.${png ? 'png' : 'jpg'}`, width: w, height: h }
}

async function rasterize(file, type) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const side = Math.max(img.naturalWidth || 512, img.naturalHeight || 512)
    const scale = Math.min(4, 1024 / side)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 512) * scale))
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 512) * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await canvasBlob(canvas, type, 0.9)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const canvasBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality))

// ── PDF ──────────────────────────────────────────────────────────────────────

let pdfjsPromise
function loadPdfJs() {
  // The worker is fetched here and started from a same-origin blob: sturdier than letting
  // pdf.js start it straight from the CDN (a worker that can't load would hang forever).
  pdfjsPromise ??= Promise.all([
    import(PDFJS),
    fetch(PDFJS_WORKER).then((res) => {
      if (!res.ok) throw new Error(`pdf.js worker: HTTP ${res.status}`)
      return res.blob()
    }),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }))
    return lib
  }).catch((err) => {
    pdfjsPromise = undefined
    throw err
  })
  return pdfjsPromise
}

async function readPdf(file, base) {
  let pdf
  let task
  try {
    const pdfjs = await loadPdfJs()
    task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    pdf = await task.promise
  } catch (err) {
    task?.destroy()
    if (err?.name === 'PasswordException') return fileOnly(base, 'A password-protected PDF, which can\'t be read here.')
    console.warn('Could not read PDF', err)
    return fileOnly(base, "A PDF that couldn't be read.")
  }
  try {
    const pages = []
    let chars = 0
    for (let i = 1; i <= pdf.numPages && chars < MAX_TEXT; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const text = content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      pages.push(`--- Page ${i} ---\n${text}`)
      chars += text.length
      page.cleanup()
    }
    const meta = { pages: pdf.numPages }
    const readable = pages.join('').replace(/--- Page \d+ ---|\s/g, '').length
    if (readable >= Math.max(40, 25 * Math.min(pdf.numPages, 20))) {
      return withText({ ...base, kind: 'document', meta }, pages.join('\n\n'))
    }
    // Little or no text: probably scanned. Let the model look at the first pages instead.
    const images = []
    for (let i = 1; i <= Math.min(pdf.numPages, SCANNED_PAGES); i++) {
      const page = await pdf.getPage(i)
      const unit = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2.5, 1600 / Math.max(unit.width, unit.height)) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      await page.render({ canvas, viewport }).promise
      images.push({ blob: await canvasBlob(canvas, 'image/jpeg', 0.85), name: `page-${i}.jpg` })
      page.cleanup()
    }
    const shown = images.length < pdf.numPages ? `the first ${images.length} of ${pdf.numPages} pages` : `all ${pdf.numPages} pages`
    const note = `[This PDF looks scanned (it has almost no text), so ${shown} are attached as images.]`
    return withText({ ...base, kind: 'document', images, meta: { ...meta, scanned: true } }, `${note}\n\n${pages.join('\n\n')}`.trim())
  } finally {
    task.destroy()
  }
}

// ── Video ────────────────────────────────────────────────────────────────────

async function readVideo(file, base) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    video.src = url
    await waitFor(video, 'loadeddata', 20_000)
    if (!video.videoWidth) throw new Error('no picture (audio only?)')
    let duration = video.duration
    if (!Number.isFinite(duration)) {
      // Some recordings (e.g. WebM from a browser) don't know their length until you seek to the end.
      video.currentTime = 1e7
      await waitFor(video, 'seeked', 10_000).catch(() => {})
      duration = Number.isFinite(video.duration) ? video.duration : 0
    }
    const count = duration > 0 ? Math.min(VIDEO_FRAMES, Math.max(1, Math.ceil(duration / 4))) : 1
    const times = Array.from({ length: count }, (_, i) => (duration > 0 ? (duration * (i + 0.5)) / count : 0))
    const scale = Math.min(1, VIDEO_SIDE / Math.max(video.videoWidth || VIDEO_SIDE, video.videoHeight || VIDEO_SIDE))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((video.videoWidth || VIDEO_SIDE) * scale))
    canvas.height = Math.max(1, Math.round((video.videoHeight || VIDEO_SIDE) * scale))
    const ctx = canvas.getContext('2d')
    const images = []
    for (const [i, time] of times.entries()) {
      if (Math.abs(video.currentTime - time) > 0.01) {
        video.currentTime = time
        await waitFor(video, 'seeked', 10_000)
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      images.push({ blob: await canvasBlob(canvas, 'image/jpeg', 0.82), name: `frame-${i + 1}.jpg` })
    }
    const at = times.map(clock).join(', ')
    const text = duration > 0
      ? `[A video, ${clock(duration)} long. ${count} ${count === 1 ? 'frame' : 'frames'} from it ${count === 1 ? 'is' : 'are'} attached as images, taken at ${at}. The sound isn't included.]`
      : '[A video. Its first frame is attached as an image. The sound isn\'t included.]'
    return withText({ ...base, kind: 'document', images, meta: { duration: Math.round(duration), frames: count } }, text)
  } catch (err) {
    console.warn('Could not read video', base.name, err)
    return fileOnly(base, "A video this browser can't play, so the model can't see it. Converting it to MP4 would help.")
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function waitFor(target, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`${event} timed out`)), ms)
    const onEvent = () => done()
    const onError = () => done(new Error('media error'))
    function done(err) {
      clearTimeout(timer)
      target.removeEventListener(event, onEvent)
      target.removeEventListener('error', onError)
      err ? reject(err) : resolve()
    }
    target.addEventListener(event, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

// ── Office, OpenDocument, EPUB (all ZIP files full of XML) ──────────────────

let fflatePromise
const loadFflate = () => (fflatePromise ??= import(FFLATE).catch((err) => {
  fflatePromise = undefined
  throw err
}))

async function unzip(buffer, filter) {
  const { unzipSync } = await loadFflate()
  return unzipSync(new Uint8Array(buffer), filter ? { filter } : undefined)
}

const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes)
const xml = (bytes) => {
  const doc = new DOMParser().parseFromString(utf8(bytes), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('damaged XML')
  return doc
}
const byName = (root, local) => [...root.getElementsByTagNameNS('*', local)]
const kids = (node, local) => [...node.children].filter((c) => c.localName === local)
const numberIn = (path) => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0)

async function readZipDocument(type, buffer) {
  const files = await unzip(buffer)
  const need = (path) => {
    if (!files[path]) throw new Error('not a valid document')
    return files[path]
  }
  if (type === 'docx') return { text: docxText(xml(need('word/document.xml'))), meta: {} }
  if (type === 'xlsx') return xlsxText(files, need)
  if (type === 'pptx') return pptxText(files)
  if (type === 'odf') return { text: odfText(xml(need('content.xml'))), meta: {} }
  return epubText(files, need)
}

function docxText(doc) {
  const out = []
  const paragraph = (p) => {
    let text = ''
    const walk = (node) => {
      for (const child of node.children) {
        const n = child.localName
        if (n === 't') text += child.textContent
        else if (n === 'tab') text += '\t'
        else if (n === 'br' || n === 'cr') text += '\n'
        else if (n !== 'delText' && n !== 'instrText' && n !== 'pPr' && n !== 'rPr') walk(child)
      }
    }
    walk(p)
    const style = p.getElementsByTagNameNS('*', 'pStyle')[0]?.getAttributeNS?.(p.namespaceURI, 'val') ??
      p.getElementsByTagNameNS('*', 'pStyle')[0]?.getAttribute('w:val') ?? ''
    const heading = /^(?:Heading|Judul)(\d)$/i.exec(style)?.[1] ?? (/^Title$/i.test(style) ? '1' : '')
    const list = p.getElementsByTagNameNS('*', 'numPr').length > 0 || /^List(Bullet|Number|Continue)?\d*$/i.test(style)
    if (heading && text.trim()) return `${'#'.repeat(Number(heading))} ${text.trim()}`
    return list && text.trim() ? `- ${text}` : text
  }
  const table = (tbl) => {
    const rows = kids(tbl, 'tr').map((tr) =>
      kids(tr, 'tc').map((tc) => kids(tc, 'p').map(paragraph).join(' ').replace(/\|/g, '\\|').trim())
    )
    const lines = rows.map((cells) => `| ${cells.join(' | ')} |`)
    if (rows.length) lines.splice(1, 0, `|${rows[0].map(() => ' --- ').join('|')}|`) // header separator: valid Markdown
    return lines.join('\n')
  }
  const block = (node) => {
    for (const child of node.children) {
      if (child.localName === 'p') out.push(paragraph(child))
      else if (child.localName === 'tbl') out.push('', table(child), '')
      else if (child.localName === 'sdt' || child.localName === 'sdtContent' || child.localName === 'customXml') block(child)
    }
  }
  const body = byName(doc, 'body')[0]
  if (body) block(body)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function relTargets(files, relsPath, baseDir) {
  const map = new Map()
  if (!files[relsPath]) return map
  for (const rel of byName(xml(files[relsPath]), 'Relationship')) {
    const target = rel.getAttribute('Target') ?? ''
    const path = target.startsWith('/') ? target.slice(1) : normalize(`${baseDir}/${target}`)
    map.set(rel.getAttribute('Id'), { path, type: rel.getAttribute('Type') ?? '' })
  }
  return map
}

function normalize(path) {
  const parts = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

function xlsxText(files, need) {
  const shared = files['xl/sharedStrings.xml']
    ? byName(xml(files['xl/sharedStrings.xml']), 'si').map((si) =>
      byName(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join('')
    )
    : []
  const rels = relTargets(files, 'xl/_rels/workbook.xml.rels', 'xl')
  const sheets = byName(xml(need('xl/workbook.xml')), 'sheet')
  const out = []
  for (const sheet of sheets) {
    const rid = [...sheet.attributes].find((a) => a.localName === 'id')?.value
    const path = rels.get(rid)?.path
    if (!path || !files[path]) continue
    const rows = []
    for (const row of byName(xml(files[path]), 'row')) {
      const cells = []
      for (const c of kids(row, 'c')) {
        const col = colIndex(c.getAttribute('r')) ?? cells.length
        const t = c.getAttribute('t')
        const v = kids(c, 'v')[0]?.textContent ?? ''
        let value = t === 's'
          ? shared[Number(v)] ?? ''
          : t === 'inlineStr'
          ? byName(c, 't').map((x) => x.textContent).join('')
          : t === 'b'
          ? (v === '1' ? 'TRUE' : 'FALSE')
          : v
        if (!value && kids(c, 'f')[0]) value = `=${kids(c, 'f')[0].textContent}`
        cells[col] = value
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      rows.push(Array.from(cells, (v) => csv(v ?? '')).join(','))
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop()
    out.push(`## Sheet: ${sheet.getAttribute('name') ?? ''}\n${rows.join('\n')}`)
  }
  return { text: out.join('\n\n'), meta: { sheets: sheets.length } }
}

function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref ?? '')?.[1]
  if (!letters) return null
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const csv = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

function pptxText(files) {
  const slides = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => numberIn(a) - numberIn(b))
  const paragraphs = (doc) =>
    byName(doc, 'p').map((p) => byName(p, 't').map((t) => t.textContent).join('')).filter((t) => t.trim())
  const out = slides.map((path, i) => {
    const lines = paragraphs(xml(files[path]))
    const rels = relTargets(files, path.replace('slides/', 'slides/_rels/') + '.rels', 'ppt/slides')
    const notesPath = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))?.path
    const notes = notesPath && files[notesPath]
      ? paragraphs(xml(files[notesPath])).filter((t) => !/^\d+$/.test(t.trim()))
      : []
    return `## Slide ${i + 1}\n${lines.join('\n')}${notes.length ? `\n\nSpeaker notes:\n${notes.join('\n')}` : ''}`
  })
  return { text: out.join('\n\n'), meta: { pages: slides.length } }
}

function odfText(doc) {
  const out = []
  let slide = 0
  const inline = (node) => {
    let text = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue
      else if (child.localName === 'tab') text += '\t'
      else if (child.localName === 'line-break') text += '\n'
      else if (child.localName === 's') text += ' '.repeat(Number(child.getAttribute('text:c') ?? 1) || 1)
      else if (child.localName !== 'note') text += inline(child)
    }
    return text
  }
  const table = (tbl) => {
    const rows = []
    for (const row of byName(tbl, 'table-row')) {
      const cells = []
      for (const cell of kids(row, 'table-cell')) {
        const value = kids(cell, 'p').map(inline).join(' ')
        const repeat = Number(cell.getAttribute('table:number-columns-repeated') ?? 1)
        for (let i = 0; i < (value ? Math.min(repeat, 100) : 1); i++) cells.push(value)
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      rows.push(cells.map(csv).join(','))
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop()
    return rows.join('\n')
  }
  const walk = (node) => {
    for (const child of node.children) {
      const n = child.localName
      if (n === 'h') out.push(`${'#'.repeat(Number(child.getAttribute('text:outline-level') ?? 1) || 1)} ${inline(child).trim()}`)
      else if (n === 'p') out.push(inline(child))
      else if (n === 'table') out.push(`## ${child.getAttribute('table:name') ?? 'Table'}\n${table(child)}`)
      else if (n === 'page') {
        out.push(`## Slide ${++slide}`)
        walk(child)
      } else walk(child)
    }
  }
  const body = byName(doc, 'body')[0]
  if (body) walk(body)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function epubText(files, need) {
  const container = xml(need('META-INF/container.xml'))
  const opfPath = byName(container, 'rootfile')[0]?.getAttribute('full-path') ?? ''
  const opf = xml(need(opfPath))
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const manifest = new Map(byName(opf, 'item').map((i) => [i.getAttribute('id'), i.getAttribute('href')]))
  const chapters = byName(opf, 'itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter(Boolean)
  const text = chapters.map((href) => {
    const bytes = files[normalize(`${dir}/${decodeURIComponent(href)}`)]
    return bytes ? htmlText(utf8(bytes)) : ''
  }).filter(Boolean)
  return { text: text.join('\n\n'), meta: { pages: chapters.length } }
}

function htmlText(html) {
  const marked = html.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>|<br\s*\/?>/gi, '$&\n')
  const doc = new DOMParser().parseFromString(marked, 'text/html')
  doc.querySelectorAll('script, style').forEach((n) => n.remove())
  return (doc.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── ZIP archives ─────────────────────────────────────────────────────────────

async function readZipArchive(buffer) {
  const listing = []
  const files = await unzip(buffer, (entry) => {
    if (!entry.name.endsWith('/')) listing.push({ name: entry.name, size: entry.originalSize })
    return !entry.name.endsWith('/') && !ZIP_SKIP.test(entry.name) && entry.originalSize <= 512 * 1024 &&
      !IMAGE_EXT.has(extOf(entry.name))
  })
  const shown = listing.slice(0, 500)
  const parts = [
    `Files in this archive (${listing.length}):`,
    ...shown.map((f) => `- ${f.name} (${f.size.toLocaleString('en')} bytes)`),
    ...(listing.length > shown.length ? [`- … and ${listing.length - shown.length} more`] : []),
  ]
  let chars = parts.join('\n').length
  for (const name of Object.keys(files).sort()) {
    const text = decodeText(files[name])
    if (text === null || !text.trim()) continue
    if (chars + text.length > MAX_TEXT - 1000) {
      parts.push(`\n[Stopped here: the rest of the files don't fit.]`)
      break
    }
    parts.push(`\n--- ${name} ---\n${text}`)
    chars += text.length + name.length + 10
  }
  return parts.join('\n')
}

// ── Display helpers ──────────────────────────────────────────────────────────

export function formatSize(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Short label for a file chip, e.g. "PDF · 12 pages" or "XLSX". */
export function typeLabel({ name, mime, meta }) {
  const ext = extOf(name).toUpperCase()
  const kind = ext || (mime?.split('/')[1] ?? 'File').toUpperCase().slice(0, 12)
  if (meta?.pages && ext === 'PDF') return `${kind} · ${meta.pages} ${meta.pages === 1 ? 'page' : 'pages'}`
  if (meta?.pages && /^(PPTX|PPTM|ODP|KEY)$/.test(ext)) return `${kind} · ${meta.pages} ${meta.pages === 1 ? 'slide' : 'slides'}`
  if (meta?.sheets) return `${kind} · ${meta.sheets} ${meta.sheets === 1 ? 'sheet' : 'sheets'}`
  if (meta?.duration) return `${kind} · ${clock(meta.duration)}`
  return kind
}

/** Storage keys allow only a limited set of characters. */
export function storageName(name) {
  const cleaned = name.normalize('NFKD').replace(/[^\w.\-() ]+/g, '_').replace(/_+/g, '_').trim()
  return (cleaned || 'file').slice(-120)
}
