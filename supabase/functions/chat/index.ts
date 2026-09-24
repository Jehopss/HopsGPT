// ─────────────────────────────────────────────────────────────────────────────
// Minimal Chat — Edge Function "chat"
//
// Streams a reply from any OpenAI-compatible API (OpenRouter, GutsAI, OpenAI, …)
// and stores the whole chat in Supabase. The model gets as context: the chat
// history, your instructions, what it remembers about you (memory), excerpts
// from past chats (optional) and how to make artifacts.
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   LLM_API_KEY           required  your provider API key
//   LLM_BASE_URL          optional  default https://openrouter.ai/api/v1
//   ALLOWED_EMAILS        optional  comma-separated emails allowed to chat (recommended)
//   ALLOWED_MODELS        optional  comma-separated model ids; empty = any model
//   DEFAULT_MODEL         optional  used when the browser sends no model
//   MEMORY_MODEL          optional  model that updates memory (default: the chat's model)
//   SYSTEM_PROMPT         optional  base system prompt; {date} becomes today's date
//   CONTEXT_MAX_MESSAGES  optional  how many recent messages the model sees (default 40)
//   CONTEXT_MAX_CHARS     optional  character budget for that history (default 60000)
//   MAX_OUTPUT_TOKENS     optional  cap on reply length (default: provider default)
//   CONTEXT_MAX_FILE_CHARS optional characters of attached files the model sees (default 150000)
//   CONTEXT_MAX_IMAGES    optional  how many attached images the model sees (default 10)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0'

// ── Configuration ────────────────────────────────────────────────────────────

const env = (name: string) => (Deno.env.get(name) ?? '').trim()
const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean)
const int = (value: string, fallback: number) => {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const LLM_API_KEY = env('LLM_API_KEY')
const LLM_BASE_URL = (env('LLM_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
const ALLOWED_EMAILS = list(env('ALLOWED_EMAILS')).map((e) => e.toLowerCase())
const ALLOWED_MODELS = list(env('ALLOWED_MODELS'))
const DEFAULT_MODEL = env('DEFAULT_MODEL') || ALLOWED_MODELS[0] || 'anthropic/claude-sonnet-5'
const MEMORY_MODEL = env('MEMORY_MODEL')
const SYSTEM_PROMPT = env('SYSTEM_PROMPT') ||
  'You are a helpful assistant. Reply in the language the user writes in. ' +
    'Be clear and concise, and use Markdown (lists, tables, code blocks) when it helps.\n' +
    "Today's date is {date}."
const CONTEXT_MAX_MESSAGES = int(env('CONTEXT_MAX_MESSAGES'), 40)
const CONTEXT_MAX_CHARS = int(env('CONTEXT_MAX_CHARS'), 60_000)
const MAX_OUTPUT_TOKENS = int(env('MAX_OUTPUT_TOKENS'), 0)
const CONTEXT_MAX_FILE_CHARS = int(env('CONTEXT_MAX_FILE_CHARS'), 150_000)
const CONTEXT_MAX_IMAGES = int(env('CONTEXT_MAX_IMAGES'), 10)

const MAX_INPUT_CHARS = 100_000
const MAX_INSTRUCTIONS_CHARS = 20_000
const MAX_MEMORIES = 150
const MEMORY_CONTEXT_CHARS = 8_000
const CHECKPOINT_EVERY_MS = 2_000
const HEARTBEAT_EVERY_MS = 15_000
const MAX_ATTACHMENTS = 10
const BUCKET = 'chat-files'
const UPGRADE_V3 = 'Files, editing and retrying need a database update. Run supabase/upgrade-v3.sql in the SQL Editor.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const IS_OPENROUTER = LLM_BASE_URL.includes('openrouter.ai')
const IS_OPENAI = LLM_BASE_URL.includes('api.openai.com')

const ARTIFACT_PROMPT =
  `You can create artifacts: self-contained content shown in a side panel next to the chat, where the user can preview, copy and download it.
Use an artifact for a complete web page, app, game or UI mockup (HTML), an SVG image, or a long document the user will reuse (Markdown, roughly 20+ lines). Don't use one for short code snippets, explanations or ordinary answers.
Format:
<artifact id="kebab-case-id" type="html|svg|markdown" title="Short title">
full content
</artifact>
- HTML must be one complete document with inline CSS and JS. External scripts and styles may only come from https://cdn.jsdelivr.net or https://cdnjs.cloudflare.com.
- To revise an artifact, reuse its id and write the full updated content, never a partial diff.
- Don't put code fences inside or around the artifact tag. Keep the text outside the artifact short.`

const MEMORY_SYSTEM =
  `You maintain the long-term memory a chat assistant keeps about its user. Memories are short, durable facts the user shared about themselves: name, role, work, studies, ongoing projects, tools they use, and how they like answers.
Rules:
- Save only what the user said about themselves. Never save what the assistant said, one-off requests, or temporary details (today's task, a single question).
- Never save passwords, API keys, ID or card numbers, health, religion, political views, sexual orientation, or financial details such as income or debts.
- If the user explicitly asks to remember something, save it. If they ask to forget or change something, delete or update it.
- Update an existing memory instead of adding a duplicate. Keep each memory to one short sentence, in the language the user used.
- Most exchanges need no change at all.
Reply with JSON only: {"add": ["..."], "update": [{"id": "<id>", "content": "..."}], "delete": ["<id>"]}. Use empty arrays when nothing changes.`

const STOPWORDS = new Set(
  ('the and for you are with this that what how can could would should about have has from your into then than there ' +
    'they them was were will just like want need make please yang dan ini itu aja ada apa bisa dong sih nya untuk ' +
    'dengan dari kalau kalo tapi juga udah sudah mau buat gimana kenapa saya aku kamu gue kita kami mereka jadi lagi ' +
    'banget atau pake pakai kasih tolong bikin coba').split(' '),
)

// Supabase injects these. New projects have publishable/secret keys (JSON maps);
// older ones have the legacy anon/service_role keys. Either works.
function pickKey(jsonName: string, ...plainNames: string[]): string {
  const raw = env(jsonName)
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>
      const key = keys.default ?? Object.values(keys)[0]
      if (typeof key === 'string' && key) return key
    } catch { /* not JSON — ignore */ }
  }
  for (const name of plainNames) if (env(name)) return env(name)
  return ''
}

const SUPABASE_URL = env('SUPABASE_URL')
const PUBLISHABLE_KEY = pickKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY')
const SECRET_KEY = pickKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
const JWKS = (() => {
  try {
    const jwks = JSON.parse(env('SUPABASE_JWKS'))
    return Array.isArray(jwks?.keys) && jwks.keys.length ? jwks : undefined
  } catch {
    return undefined
  }
})()

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
// Reused across requests so the signing keys stay cached.
const authClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: NO_SESSION })
// Saves replies and memories even if the user's token expires mid-stream.
// Bypasses RLS, so every write through it names the already-verified user.
const adminClient = SECRET_KEY ? createClient(SUPABASE_URL, SECRET_KEY, { auth: NO_SESSION }) : null

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatRequest {
  action?: unknown
  conversation_id?: string | null
  parent_id?: unknown
  message_id?: unknown
  message?: unknown
  attachment_ids?: unknown
  model?: unknown
  system_prompt?: unknown
  timezone?: unknown
  instruction?: unknown
}

interface Prefs {
  artifacts?: boolean
  memory?: boolean
  referenceChats?: boolean
}

interface HistoryRow {
  id?: string
  role: 'user' | 'assistant'
  content: string
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

interface AttachmentRow {
  id: string
  conversation_id: string | null
  message_id: string | null
  name: string
  mime: string
  size: number
  kind: 'image' | 'document' | 'file'
  storage_path: string | null
  image_paths: string[] | null
  text_chars: number
  position: number
  meta: Record<string, unknown> | null
  text_content?: string | null
}

const ATTACHMENT_FIELDS =
  'id, conversation_id, message_id, name, mime, size, kind, storage_path, image_paths, text_chars, position, meta'

interface MemoryRow {
  id: string
  content: string
}

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
}

/** One `data:` payload of an OpenAI-compatible streaming response. */
interface StreamChunk {
  error?: unknown
  usage?: Usage
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      reasoning_details?: unknown[]
    }
    finish_reason?: string | null
  }>
}

type StreamEvent =
  | {
    type: 'meta'
    conversation_id: string
    title: string
    created: boolean
    user_message_id: string
    parent_id: string | null
    model: string
  }
  | { type: 'thinking' }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'saved'; message_id: string } // the reply's id, as soon as it's first saved (Stop may come before 'done')
  | { type: 'done'; message_id: string | null; saved: boolean; finish_reason: string | null }
  | { type: 'memory'; changes: number }

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  try {
    return await handleRequest(req)
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('chat: unexpected error', err)
    return json({ error: `Server error: ${errorText(err)}` }, 500)
  }
})

async function handleRequest(req: Request): Promise<Response> {
  // 1. Who is calling? (the platform already checked the JWT; we verify again
  //    so the function stays safe even if JWT verification is switched off)
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new HttpError(401, 'Sign in to chat.')
  const { data: auth, error: authError } = await authClient.auth.getClaims(token, JWKS ? { jwks: JWKS } : undefined)
  const claims = auth?.claims
  if (authError || !claims?.sub || claims.role !== 'authenticated') {
    throw new HttpError(401, 'Your session has expired. Sign in again.')
  }
  const userId = claims.sub
  const email = String(claims.email ?? '').toLowerCase()
  if (claims.is_anonymous || (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email))) {
    throw new HttpError(403, 'This account is not allowed to use this chat.')
  }
  if (!LLM_API_KEY) throw new HttpError(500, 'LLM_API_KEY is not set. Add it under Edge Functions → Secrets.')

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'Invalid JSON body.')
  }

  // Database client that acts as the user (RLS applies)
  const db = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: NO_SESSION,
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  if (body.action === 'memory_edit') return handleMemoryEdit(body, db, userId)
  return handleChat(body, db, userId)
}

async function handleChat(body: ChatRequest, db: SupabaseClient, userId: string): Promise<Response> {
  // 2. Validate the request
  const regenerate = body.action === 'regenerate'
  const v3 = await hasV3(db)
  const attachmentIds = parseIds(body.attachment_ids)
  if ((regenerate || attachmentIds.length > 0) && !v3) throw new HttpError(400, UPGRADE_V3)
  const text = !regenerate && typeof body.message === 'string' ? clean(body.message).trim() : ''
  if (!regenerate && !text && attachmentIds.length === 0) throw new HttpError(400, 'Message is empty.')
  if (text.length > MAX_INPUT_CHARS) {
    throw new HttpError(413, `Message is too long (max ${MAX_INPUT_CHARS.toLocaleString('en')} characters).`)
  }
  const model = pickModel(body.model)

  // 3. Find the chat, or create it on the first message
  let conversation: { id: string; title: string; system_prompt: string }
  const isNew = !body.conversation_id
  if (regenerate && isNew) throw new HttpError(400, 'Nothing to retry yet.')
  let attachments: AttachmentRow[] = []
  if (attachmentIds.length > 0) attachments = await loadAttachmentsById(db, attachmentIds)
  if (!isNew) {
    const id = String(body.conversation_id)
    if (!UUID.test(id)) throw new HttpError(404, 'Chat not found.')
    const { data, error } = await db.from('chat_conversations').select('id, title, system_prompt').eq('id', id)
      .maybeSingle()
    if (error) throw dbError(error)
    if (!data) throw new HttpError(404, 'Chat not found.')
    conversation = data
  } else {
    const instructions = typeof body.system_prompt === 'string'
      ? clean(body.system_prompt).slice(0, MAX_INSTRUCTIONS_CHARS)
      : ''
    const { data, error } = await db
      .from('chat_conversations')
      .insert({
        user_id: userId,
        title: titleFrom(text || attachments[0]?.name || ''),
        model,
        system_prompt: instructions,
      })
      .select('id, title, system_prompt')
      .single()
    if (error) throw dbError(error)
    conversation = data
  }

  // 4. Save the user's message (or, for "Retry", find the one being answered again)
  let userMessageId: string
  let userText: string
  let parentId: string | null = null
  if (regenerate) {
    const id = String(body.message_id ?? '')
    if (!UUID.test(id)) throw new HttpError(400, 'Nothing to retry.')
    const { data, error } = await db.from('chat_messages').select('id, role, content, parent_id')
      .eq('id', id).eq('conversation_id', conversation.id).maybeSingle()
    if (error) throw dbError(error)
    if (!data || data.role !== 'user') throw new HttpError(404, 'That message no longer exists.')
    userMessageId = data.id
    userText = data.content
    parentId = data.parent_id
  } else {
    for (const a of attachments) {
      const fresh = a.message_id === null && (a.conversation_id === null || a.conversation_id === conversation.id)
      const reused = a.message_id !== null && a.conversation_id === conversation.id
      if (!fresh && !reused) throw new HttpError(400, `"${a.name}" can't be attached here. Attach it again.`)
    }
    if (v3 && !isNew) parentId = await pickParent(db, body, conversation.id)
    const { data: userMessage, error: insertError } = await db
      .from('chat_messages')
      .insert({
        conversation_id: conversation.id,
        user_id: userId,
        role: 'user',
        content: text,
        ...(v3 ? { parent_id: parentId } : {}),
      })
      .select('id')
      .single()
    if (insertError) throw dbError(insertError)
    userMessageId = userMessage.id
    userText = text
    if (attachments.length > 0) await linkAttachments(db, attachments, conversation.id, userMessageId)
  }
  if (v3) await setLeaf(db, conversation.id, userMessageId)

  // 5. Build the context: instructions, memory, past chats, this branch of the chat (+ its files)
  const [historyRows, settings, memories] = await Promise.all([
    loadHistory(db, conversation.id, v3 ? userMessageId : null),
    loadSettings(db, userId),
    loadMemories(db, userId),
  ])
  const kept = fitHistory(historyRows)
  const { messages: history, imageCount } = v3
    ? await withAttachments(db, kept, userMessageId)
    : { messages: mergeTurns(kept.map((r) => ({ role: r.role, content: r.content }))), imageCount: 0 }
  const memoryOn = settings.v2 && settings.prefs.memory !== false
  const pastChats = settings.v2 && settings.prefs.referenceChats === true && userText
    ? await searchPastChats(db, userText, conversation.id)
    : ''
  const system = buildSystemPrompt({
    customInstructions: settings.customInstructions,
    chatInstructions: conversation.system_prompt,
    timezone: typeof body.timezone === 'string' ? body.timezone : '',
    memories: memoryOn ? memories : [],
    pastChats,
    artifacts: settings.prefs.artifacts !== false,
  })
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history]
  const saveWith = adminClient ?? db

  // 6. Stream the reply back while saving it; then update memory
  return streamReply({
    userId,
    model,
    conversationId: conversation.id,
    parentId: v3 ? userMessageId : null,
    hasImages: imageCount > 0,
    meta: {
      type: 'meta',
      conversation_id: conversation.id,
      title: conversation.title,
      created: isNew,
      user_message_id: userMessageId,
      parent_id: parentId,
      model,
    },
    messages,
    saveWith,
    afterReply: memoryOn && !regenerate && userText.length >= 8
      ? async (reply) => {
        const result = await runMemoryUpdate({
          client: saveWith,
          userId,
          model: MEMORY_MODEL || model,
          memories,
          maxAdds: 5,
          task: `Latest exchange:\nUser: ${userText.slice(0, 4000)}\nAssistant: ${
            stripArtifacts(reply).slice(0, 1500)
          }`,
        })
        return result.added + result.updated + result.deleted
      }
      : undefined,
  })
}

// ── Message tree & attachments (v3) ──────────────────────────────────────────

let v3Probe: { ok: boolean; at: number } | null = null

/** True once supabase/upgrade-v3.sql has been run (checked again every 15 s until then). */
async function hasV3(db: SupabaseClient): Promise<boolean> {
  if (v3Probe && (v3Probe.ok || Date.now() - v3Probe.at < 15_000)) return v3Probe.ok
  const { error } = await db.from('chat_attachments').select('id').limit(1)
  const missing = ['PGRST205', '42P01', 'PGRST204', '42703'].includes(error?.code ?? '')
  v3Probe = { ok: !missing, at: Date.now() }
  return !missing
}

function parseIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'attachment_ids must be a list.')
  const ids = [...new Set(value.map(String))]
  if (ids.some((id) => !UUID.test(id))) throw new HttpError(400, 'Invalid attachment id.')
  if (ids.length > MAX_ATTACHMENTS) {
    throw new HttpError(400, `You can attach up to ${MAX_ATTACHMENTS} files per message.`)
  }
  return ids
}

/** The message a new one follows: what the browser says, or the end of the branch last viewed. */
async function pickParent(db: SupabaseClient, body: ChatRequest, conversationId: string): Promise<string | null> {
  if ('parent_id' in body) {
    if (body.parent_id === null) return null
    const id = String(body.parent_id)
    if (!UUID.test(id)) throw new HttpError(400, 'Invalid parent_id.')
    const { data, error } = await db.from('chat_messages').select('id').eq('id', id)
      .eq('conversation_id', conversationId).maybeSingle()
    if (error) throw dbError(error)
    if (!data) throw new HttpError(409, 'The message you replied to no longer exists. Reload the chat.')
    return data.id
  }
  const { data: conversation } = await db.from('chat_conversations').select('current_leaf_id')
    .eq('id', conversationId).maybeSingle()
  const leaf = conversation?.current_leaf_id as string | null | undefined
  if (leaf) {
    const { data } = await db.from('chat_messages').select('id').eq('id', leaf).eq('conversation_id', conversationId)
      .maybeSingle()
    if (data) return data.id
  }
  const { data: last } = await db.from('chat_messages').select('id').eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return last?.id ?? null
}

async function setLeaf(client: SupabaseClient, conversationId: string, messageId: string) {
  const { error } = await client.from('chat_conversations').update({ current_leaf_id: messageId }).eq(
    'id',
    conversationId,
  )
  if (error) console.error('chat: could not save current_leaf_id', error)
}

async function loadAttachmentsById(db: SupabaseClient, ids: string[]): Promise<AttachmentRow[]> {
  const { data, error } = await db.from('chat_attachments').select(`${ATTACHMENT_FIELDS}, text_content`).in('id', ids)
  if (error) throw dbError(error)
  const byId = new Map((data as AttachmentRow[]).map((a) => [a.id, a]))
  if (byId.size !== ids.length) {
    throw new HttpError(400, "Some attached files weren't found. Remove them and attach them again.")
  }
  return ids.map((id) => byId.get(id)!)
}

/** New uploads get linked to the message; files kept from an edited message are copied. */
async function linkAttachments(db: SupabaseClient, rows: AttachmentRow[], conversationId: string, messageId: string) {
  const copies: Record<string, unknown>[] = []
  await Promise.all(rows.map(async (a, position) => {
    if (a.message_id === null) {
      if (a.conversation_id && a.conversation_id !== conversationId) {
        throw new HttpError(400, `"${a.name}" belongs to another chat.`)
      }
      const { data, error } = await db.from('chat_attachments')
        .update({ conversation_id: conversationId, message_id: messageId, position })
        .eq('id', a.id).is('message_id', null).select('id')
      if (error) throw dbError(error)
      if (!data?.length) throw new HttpError(409, `"${a.name}" was already sent. Attach it again.`)
    } else {
      if (a.conversation_id !== conversationId) throw new HttpError(400, `"${a.name}" belongs to another chat.`)
      copies.push({
        conversation_id: conversationId,
        message_id: messageId,
        position,
        name: a.name,
        mime: a.mime,
        size: a.size,
        kind: a.kind,
        storage_path: a.storage_path,
        image_paths: a.image_paths ?? [],
        text_content: a.text_content ?? null,
        meta: a.meta ?? {},
      })
    }
  }))
  if (copies.length) {
    const { error } = await db.from('chat_attachments').insert(copies)
    if (error) throw dbError(error)
  }
}

/** The messages the model sees: this branch (v3) or the latest messages (older databases). */
async function loadHistory(db: SupabaseClient, conversationId: string, leaf: string | null): Promise<HistoryRow[]> {
  if (leaf) {
    const { data, error } = await db.rpc('chat_message_path', { leaf, max_count: CONTEXT_MAX_MESSAGES })
    if (error) throw dbError(error)
    return (data as HistoryRow[]).map((r) => ({ id: r.id, role: r.role, content: r.content }))
  }
  const { data, error } = await db
    .from('chat_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(CONTEXT_MAX_MESSAGES)
  if (error) throw dbError(error)
  return (data as HistoryRow[]).reverse()
}

/**
 * Adds attached files to the user messages that carry them. The newest files are
 * always included; older ones only while they fit CONTEXT_MAX_FILE_CHARS /
 * CONTEXT_MAX_IMAGES (the model is told about the ones left out).
 */
async function withAttachments(db: SupabaseClient, rows: HistoryRow[], latestId: string) {
  const ids = rows.filter((r) => r.role === 'user' && r.id).map((r) => r.id!)
  const byMessage = new Map<string, AttachmentRow[]>()
  if (ids.length) {
    const { data, error } = await db.from('chat_attachments').select(ATTACHMENT_FIELDS).in('message_id', ids)
      .order('position', { ascending: true })
    if (error) throw dbError(error)
    for (const a of data as AttachmentRow[]) {
      if (!byMessage.has(a.message_id!)) byMessage.set(a.message_id!, [])
      byMessage.get(a.message_id!)!.push(a)
    }
  }

  // Decide what fits, newest message first.
  let charBudget = CONTEXT_MAX_FILE_CHARS
  let imageBudget = CONTEXT_MAX_IMAGES
  const textFor = new Map<string, number>() // attachment id → characters to include
  const imagesFor = new Map<string, string[]>() // attachment id → storage paths to include
  for (const id of [...ids].reverse()) {
    for (const a of byMessage.get(id) ?? []) {
      const latest = id === latestId
      if (a.text_chars > 0) {
        const take = latest
          ? Math.min(a.text_chars, Math.max(charBudget, 2_000))
          : a.text_chars <= charBudget
          ? a.text_chars
          : 0
        if (take > 0) {
          textFor.set(a.id, take)
          charBudget = Math.max(0, charBudget - take)
        }
      }
      const paths = (a.image_paths ?? []).slice(0, latest ? Math.max(imageBudget, 1) : imageBudget)
      if (paths.length) {
        imagesFor.set(a.id, paths)
        imageBudget = Math.max(0, imageBudget - paths.length)
      }
    }
  }

  const texts = new Map<string, string>()
  if (textFor.size) {
    const { data, error } = await db.from('chat_attachments').select('id, text_content').in('id', [...textFor.keys()])
    if (error) throw dbError(error)
    for (const r of data as Array<{ id: string; text_content: string | null }>) {
      texts.set(r.id, (r.text_content ?? '').slice(0, textFor.get(r.id)))
    }
  }
  const imageUrls = new Map<string, string | null>()
  await Promise.all(
    [...imagesFor.values()].flat().map(async (path) => imageUrls.set(path, await imageDataUrl(db, path))),
  )

  let imageCount = 0
  const out: ChatMessage[] = rows.map((row) => {
    const files = row.id ? byMessage.get(row.id) : undefined
    if (row.role !== 'user' || !files?.length) return { role: row.role, content: row.content }
    const blocks: string[] = []
    const images: ContentPart[] = []
    for (const a of files) {
      const attrs = `name="${attr(a.name)}" type="${attr(a.mime)}"${a.meta?.pages ? ` pages="${a.meta.pages}"` : ''}`
      const note = typeof a.meta?.note === 'string' ? a.meta.note : ''
      if (a.text_chars > 0) {
        const body = texts.get(a.id)
        if (body !== undefined) {
          const cut = body.length < a.text_chars
            ? `\n[Only the first ${body.length.toLocaleString('en')} of ${
              a.text_chars.toLocaleString('en')
            } characters are included.]`
            : ''
          blocks.push(`<attachment ${attrs}>\n${body}${cut}\n</attachment>`)
        } else {
          blocks.push(
            `<attachment ${attrs} omitted="true">Left out to save space. Ask the user to attach it again if you need it.</attachment>`,
          )
        }
      } else if (a.kind === 'file') {
        blocks.push(
          `<attachment ${attrs} size="${formatBytes(a.size)}">${
            note || "This file's contents can't be read here; only its name and type are known."
          }</attachment>`,
        )
      }
      const paths = imagesFor.get(a.id) ?? []
      for (const path of paths) {
        const url = imageUrls.get(path)
        if (url) images.push({ type: 'image_url', image_url: { url } })
      }
      if (a.kind === 'image' && paths.length === 0) {
        blocks.push(
          `<attachment ${attrs}>An image the user sent earlier; it is no longer in your context.</attachment>`,
        )
      } else if (a.kind === 'image' && paths.some((p) => !imageUrls.get(p))) {
        blocks.push(`<attachment ${attrs}>This image couldn't be loaded.</attachment>`)
      }
    }
    imageCount += images.length
    const textPart = [...blocks, row.content].filter(Boolean).join('\n\n')
    if (!images.length) return { role: 'user', content: textPart }
    return { role: 'user', content: [...(textPart ? [{ type: 'text' as const, text: textPart }] : []), ...images] }
  })
  return { messages: mergeTurns(out), imageCount }
}

async function imageDataUrl(db: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await db.storage.from(BUCKET).download(path)
  if (error || !data) {
    console.error('chat: could not load image', path, error)
    return null
  }
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const byExt: Record<string, string> = {
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  }
  const mime = data.type?.startsWith('image/') ? data.type : byExt[ext] ?? 'image/jpeg'
  return `data:${mime};base64,${toBase64(new Uint8Array(await data.arrayBuffer()))}`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const attr = (value: string) => value.replace(/[\r\n]+/g, ' ').replaceAll('"', "'").slice(0, 255)

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

/** Settings → Memory → "Tell the assistant what to change", and memory import. */
async function handleMemoryEdit(body: ChatRequest, db: SupabaseClient, userId: string): Promise<Response> {
  const instruction = typeof body.instruction === 'string' ? clean(body.instruction).trim() : ''
  if (!instruction) throw new HttpError(400, 'Tell me what to change.')
  if (instruction.length > MAX_INSTRUCTIONS_CHARS) throw new HttpError(413, 'That text is too long.')
  const memories = await loadMemories(db, userId)
  const result = await runMemoryUpdate({
    client: adminClient ?? db,
    userId,
    model: MEMORY_MODEL || pickModel(body.model),
    memories,
    maxAdds: 50,
    task: `The user is editing their memories directly. Do exactly what they ask (add, update or delete), ` +
      `even if it is only one fact. Their request:\n"""\n${instruction}\n"""`,
  })
  return json({ ...result, memories: await loadMemories(db, userId) })
}

function pickModel(value: unknown): string {
  const model = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_MODEL
  if (!/^[\w.:/@~+-]{1,200}$/.test(model)) throw new HttpError(400, 'Invalid model id.')
  if (ALLOWED_MODELS.length > 0 && !ALLOWED_MODELS.includes(model)) {
    throw new HttpError(400, `Model "${model}" is not in ALLOWED_MODELS.`)
  }
  return model
}

// ── Context ──────────────────────────────────────────────────────────────────

/** Settings row. `v2` is false until supabase/upgrade-v2.sql has been run. */
async function loadSettings(db: SupabaseClient, userId: string) {
  const res = await db.from('chat_settings').select('custom_instructions, preferences').eq('user_id', userId)
    .maybeSingle()
  if (!res.error) {
    return {
      v2: true,
      customInstructions: String(res.data?.custom_instructions ?? ''),
      prefs: (res.data?.preferences ?? {}) as Prefs,
    }
  }
  const old = await db.from('chat_settings').select('custom_instructions').eq('user_id', userId).maybeSingle()
  return { v2: false, customInstructions: String(old.data?.custom_instructions ?? ''), prefs: {} as Prefs }
}

async function loadMemories(db: SupabaseClient, userId: string): Promise<MemoryRow[]> {
  const { data, error } = await db
    .from('chat_memories')
    .select('id, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(MAX_MEMORIES)
  return error ? [] : (data as MemoryRow[])
}

/** Keyword search over the user's other chats ("Search and reference chats"). */
async function searchPastChats(db: SupabaseClient, text: string, conversationId: string): Promise<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  const query = [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 8).join(' or ')
  if (!query) return ''
  const { data, error } = await db.rpc('search_chat_messages', {
    query,
    exclude_conversation: conversationId,
    match_count: 6,
  })
  if (error || !Array.isArray(data) || data.length === 0) return ''
  return (data as Array<{ title: string; role: string; snippet: string; created_at: string }>)
    .map((r) =>
      `- [${r.title}, ${String(r.created_at).slice(0, 10)}] ${r.role === 'user' ? 'User' : 'Assistant'}: ${
        stripArtifacts(r.snippet).replace(/\s+/g, ' ').slice(0, 400)
      }`
    )
    .join('\n')
}

/** Keep the newest messages that fit the budget, oldest first, starting with a user turn. */
function fitHistory(rows: HistoryRow[]): HistoryRow[] {
  const kept: HistoryRow[] = []
  let chars = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const length = rows[i].content.length
    if (kept.length > 0 && chars + length > CONTEXT_MAX_CHARS) break
    kept.unshift(rows[i])
    chars += length
  }
  // Some providers require the first turn to be the user's.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift()
  return kept
}

/** Providers dislike two turns in a row from the same role (e.g. after a failed reply). Merge them. */
function mergeTurns(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = []
  const parts = (c: string | ContentPart[]): ContentPart[] =>
    typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c
  for (const message of messages) {
    const last = merged[merged.length - 1]
    if (!last || last.role !== message.role) {
      merged.push({ ...message })
    } else if (typeof last.content === 'string' && typeof message.content === 'string') {
      last.content = [last.content, message.content].filter(Boolean).join('\n\n')
    } else {
      last.content = [...parts(last.content), ...parts(message.content)]
    }
  }
  return merged
}

function buildSystemPrompt(opts: {
  customInstructions: string
  chatInstructions: string
  timezone: string
  memories: MemoryRow[]
  pastChats: string
  artifacts: boolean
}): string {
  const parts = [SYSTEM_PROMPT.replaceAll('{date}', today(opts.timezone))]
  if (opts.customInstructions.trim()) {
    parts.push(`About the user and how they want you to respond:\n${opts.customInstructions.trim()}`)
  }
  if (opts.memories.length > 0) {
    let facts = ''
    for (const m of opts.memories) {
      if (facts.length + m.content.length > MEMORY_CONTEXT_CHARS) break
      facts += `- ${m.content}\n`
    }
    parts.push(
      `What you remember about the user from earlier chats (use it when relevant; don't recite this list unless asked):\n${facts.trim()}`,
    )
  }
  if (opts.pastChats) {
    parts.push(
      `Excerpts from the user's past chats that may be relevant (use them only if they help; they may be outdated):\n${opts.pastChats}`,
    )
  }
  if (opts.chatInstructions.trim()) {
    parts.push(`Instructions for this chat:\n${opts.chatInstructions.trim()}`)
  }
  if (opts.artifacts) parts.push(ARTIFACT_PROMPT)
  return parts.join('\n\n')
}

function today(timezone: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
  try {
    if (timezone) {
      return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone }).format(new Date())} (${timezone})`
    }
  } catch { /* unknown time zone — fall back to UTC */ }
  return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date())} (UTC)`
}

// ── Memory ───────────────────────────────────────────────────────────────────

async function runMemoryUpdate(opts: {
  client: SupabaseClient
  userId: string
  model: string
  memories: MemoryRow[]
  maxAdds: number
  task: string
}): Promise<{ added: number; updated: number; deleted: number }> {
  const current = opts.memories.length ? opts.memories.map((m) => `[${m.id}] ${m.content}`).join('\n') : '(none yet)'
  const raw = await complete(opts.model, [
    { role: 'system', content: MEMORY_SYSTEM },
    { role: 'user', content: `Current memories:\n${current}\n\n${opts.task}\n\nReply with the JSON object only.` },
  ], 1500)

  // Parse defensively: models sometimes wrap JSON in prose or code fences.
  let ops: { add?: unknown; update?: unknown; delete?: unknown } = {}
  try {
    ops = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    return { added: 0, updated: 0, deleted: 0 }
  }
  const ids = new Set(opts.memories.map((m) => m.id))
  const tidy = (v: unknown) => typeof v === 'string' ? clean(v).replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  const deletes = (Array.isArray(ops.delete) ? ops.delete : []).filter((id): id is string =>
    typeof id === 'string' && ids.has(id)
  )
  const updates = ((Array.isArray(ops.update) ? ops.update : []) as Array<{ id?: unknown; content?: unknown }>)
    .map((u) => ({ id: String(u?.id ?? ''), content: tidy(u?.content) }))
    .filter((u) => ids.has(u.id) && u.content && !deletes.includes(u.id))
  const known = new Set(opts.memories.map((m) => m.content.toLowerCase()))
  const room = Math.max(0, MAX_MEMORIES - (opts.memories.length - deletes.length))
  const adds = [...new Set((Array.isArray(ops.add) ? ops.add : []).map(tidy))]
    .filter((c) => c && !known.has(c.toLowerCase()))
    .slice(0, Math.min(opts.maxAdds, room))

  const now = new Date().toISOString()
  if (deletes.length) {
    const { error } = await opts.client.from('chat_memories').delete().in('id', deletes).eq('user_id', opts.userId)
    if (error) throw dbError(error)
  }
  for (const u of updates) {
    const { error } = await opts.client.from('chat_memories').update({ content: u.content, updated_at: now })
      .eq('id', u.id).eq('user_id', opts.userId)
    if (error) throw dbError(error)
  }
  if (adds.length) {
    const { error } = await opts.client.from('chat_memories')
      .insert(adds.map((content) => ({ user_id: opts.userId, content })))
    if (error) throw dbError(error)
  }
  return { added: adds.length, updated: updates.length, deleted: deletes.length }
}

function stripArtifacts(text: string): string {
  return text.replace(/<artifact\b([^>]*)>[\s\S]*?(?:<\/artifact>|$)/g, (_m, attrs: string) => {
    const title = /title="([^"]*)"/.exec(attrs)?.[1]
    return `[artifact${title ? `: ${title}` : ''}]`
  })
}

// ── Model calls ──────────────────────────────────────────────────────────────

function modelHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${LLM_API_KEY}`,
    'Content-Type': 'application/json',
  }
  if (IS_OPENROUTER) headers['X-Title'] = 'Minimal Chat'
  return headers
}

function outputLimit(tokens: number): Record<string, number> {
  return tokens > 0 ? { [IS_OPENAI ? 'max_completion_tokens' : 'max_tokens']: tokens } : {}
}

function postCompletion(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: modelHeaders(),
    body: JSON.stringify(payload),
    signal,
  })
}

/** Streaming call. Asks for token usage; retries without if the provider rejects that option. */
async function callModel(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<Response> {
  const base = { model, messages, stream: true, ...outputLimit(MAX_OUTPUT_TOKENS) }
  const res = await postCompletion({ ...base, stream_options: { include_usage: true } }, signal)
  if (res.status === 400 || res.status === 422) {
    const detail = await res.clone().text().catch(() => '')
    if (/stream_options|include_usage/i.test(detail)) {
      res.body?.cancel().catch(() => {})
      return postCompletion(base, signal)
    }
  }
  return res
}

/** Non-streaming call that returns the reply text (used for memory updates). */
async function complete(model: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
  const res = await postCompletion(
    { model, messages, stream: false, ...outputLimit(maxTokens) },
    AbortSignal.timeout(90_000),
  )
  if (!res.ok) throw new HttpError(502, await describeUpstreamError(res))
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p: { text?: string }) => p?.text ?? '').join('')
  return ''
}

// ── Streaming ────────────────────────────────────────────────────────────────

function streamReply(opts: {
  userId: string
  model: string
  conversationId: string
  parentId: string | null
  hasImages: boolean
  meta: StreamEvent
  messages: ChatMessage[]
  saveWith: SupabaseClient
  afterReply?: (reply: string) => Promise<number>
}): Response {
  const encoder = new TextEncoder()
  const upstreamAbort = new AbortController()
  let clientGone = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (clientGone) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          clientGone = true
        }
      }
      const send = (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`)
      const close = () => {
        clearInterval(heartbeat)
        if (clientGone) return
        clientGone = true
        try {
          controller.close()
        } catch { /* already closed */ }
      }

      const work = (async () => {
        heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_EVERY_MS)
        send(opts.meta)

        const saver = createSaver(opts, (id) => send({ type: 'saved', message_id: id }))
        let content = ''
        let usage: Usage | null = null
        let finishReason: string | null = null
        let errorMessage: string | null = null
        let thinkingSent = false

        try {
          const res = await callModel(opts.model, opts.messages, upstreamAbort.signal)
          if (!res.ok || !res.body) {
            errorMessage = await describeUpstreamError(res, opts.hasImages)
          } else {
            for await (const data of readSSE(res.body)) {
              if (data === '[DONE]') break
              let chunk: StreamChunk
              try {
                chunk = JSON.parse(data)
              } catch {
                continue
              }
              if (chunk.error) {
                errorMessage = `The model returned an error: ${upstreamMessage(chunk.error)}`
                finishReason = 'error'
                break
              }
              if (chunk.usage) usage = chunk.usage
              const choice = chunk.choices?.[0]
              if (!choice) continue
              const delta = choice.delta ?? {}
              if (typeof delta.content === 'string' && delta.content) {
                const piece = clean(delta.content)
                content += piece
                send({ type: 'delta', text: piece })
                saver.checkpoint(content)
              } else if (
                !thinkingSent && !content &&
                (delta.reasoning || delta.reasoning_content || delta.reasoning_details?.length)
              ) {
                thinkingSent = true
                send({ type: 'thinking' })
              }
              if (choice.finish_reason) finishReason = choice.finish_reason
            }
          }
        } catch (err) {
          if (!upstreamAbort.signal.aborted) errorMessage = `Could not reach the model: ${errorText(err)}`
        }

        if (upstreamAbort.signal.aborted) finishReason = 'stopped'
        if (finishReason === 'error' && !errorMessage) errorMessage = 'The model stopped with an error.'
        if (!content && !errorMessage && finishReason !== 'stopped') {
          errorMessage = finishReason === 'length'
            ? 'The model hit its token limit before writing any text. Try again, or raise MAX_OUTPUT_TOKENS.'
            : finishReason === 'content_filter'
            ? "The provider's content filter blocked this reply."
            : 'The model returned an empty reply. Try again or pick another model.'
        }
        const promptChars = opts.messages.reduce(
          (n, m) =>
            n +
            (typeof m.content === 'string'
              ? m.content.length
              : m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 4_000), 0)),
          0,
        )
        const saved = await saver.finish(content, { usage, finishReason, promptChars })
        if (errorMessage) send({ type: 'error', message: errorMessage })
        send({ type: 'done', message_id: saved.id, saved: saved.ok, finish_reason: finishReason })

        // Memory is updated after the reply is shown, so it never slows the answer down.
        if (opts.afterReply && content && !errorMessage && finishReason !== 'stopped') {
          try {
            const changes = await opts.afterReply(content)
            if (changes > 0) send({ type: 'memory', changes })
          } catch (err) {
            console.error('chat: memory update failed', err)
          }
        }
        close()
      })().catch((err) => {
        console.error('chat: stream failed', err)
        send({ type: 'error', message: `Server error: ${errorText(err)}` })
        close()
      })

      waitUntil(work)
    },
    cancel() {
      // The browser went away or pressed Stop: stop paying for tokens, keep what we have.
      clientGone = true
      clearInterval(heartbeat)
      upstreamAbort.abort()
    },
  })

  return new Response(body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

/** Writes the reply to the database while it streams, so a cut-off stream still leaves most of it saved. */
function createSaver(
  opts: {
    userId: string
    model: string
    conversationId: string
    parentId: string | null
    saveWith: SupabaseClient
  },
  onFirstSave?: (id: string) => void,
) {
  let messageId: string | null = null
  let lastCheckpoint = 0
  let ok = true
  let queue: Promise<void> = Promise.resolve()

  const save = async (fields: Record<string, unknown>) => {
    if (!messageId) {
      const { data, error } = await opts.saveWith
        .from('chat_messages')
        .insert({
          conversation_id: opts.conversationId,
          user_id: opts.userId,
          role: 'assistant',
          model: opts.model,
          ...(opts.parentId ? { parent_id: opts.parentId } : {}),
          ...fields,
        })
        .select('id')
        .single()
      if (error) throw error
      messageId = data.id
      if (opts.parentId) await setLeaf(opts.saveWith, opts.conversationId, data.id)
      onFirstSave?.(data.id)
    } else {
      const { error } = await opts.saveWith.from('chat_messages').update(fields).eq('id', messageId)
      if (error) throw error
    }
  }

  const write = (content: string, extra: Record<string, unknown> = {}) => {
    queue = queue.then(async () => {
      if (!content) return
      const fields: Record<string, unknown> = { content, ...extra }
      try {
        await save(fields)
      } catch (err) {
        // Database not upgraded yet (no tokens_estimated column): save without it.
        const code = (err as { code?: string })?.code
        if (!('tokens_estimated' in fields) || (code !== 'PGRST204' && code !== '42703')) throw err
        delete fields.tokens_estimated
        await save(fields)
      }
      ok = true
    }).catch((err) => {
      ok = false
      console.error('chat: saving the reply failed', err)
    })
    return queue
  }

  return {
    checkpoint(content: string) {
      const now = Date.now()
      if (now - lastCheckpoint < CHECKPOINT_EVERY_MS) return
      lastCheckpoint = now
      write(content)
    },
    async finish(content: string, info: { usage: Usage | null; finishReason: string | null; promptChars: number }) {
      // No usage from the provider? Estimate (~4 characters per token) so Usage still shows something.
      const estimated = !info.usage?.completion_tokens && !info.usage?.prompt_tokens
      await write(content, {
        finish_reason: info.finishReason,
        prompt_tokens: estimated ? Math.ceil(info.promptChars / 4) : info.usage?.prompt_tokens ?? null,
        completion_tokens: estimated ? Math.ceil(content.length / 4) : info.usage?.completion_tokens ?? null,
        ...(estimated ? { tokens_estimated: true } : {}),
      })
      return { id: messageId, ok: content ? ok && messageId !== null : true }
    },
  }
}

/** Parses a server-sent-events body into the payloads of its `data:` fields. */
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split(/\r\n|\r|\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
        } // ":" comments (keep-alives), "event:", "id:" are ignored
      }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(buffer.startsWith('data: ') ? 6 : 5))
    if (data.length > 0) yield data.join('\n')
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function describeUpstreamError(res: Response, hadImages = false): Promise<string> {
  let detail = ''
  try {
    const raw = (await res.text()).slice(0, 4000)
    try {
      const parsed = JSON.parse(raw)
      detail = upstreamMessage(parsed.error ?? parsed)
    } catch {
      detail = raw
    }
  } catch { /* no body */ }
  const hints: Record<number, string> = {
    401: 'Check the LLM_API_KEY secret.',
    402: 'Your provider account may be out of credits.',
    403: 'Check the LLM_API_KEY secret and your provider account.',
    404: 'Check the model id and LLM_BASE_URL.',
    429: 'Rate limited. Wait a moment and try again.',
  }
  detail = detail.trim().slice(0, 600)
  if (detail && !/[.!?]$/.test(detail)) detail += '.'
  const hint = hadImages && [400, 404, 413, 415, 422].includes(res.status)
    ? 'This model may not accept images, or the images are too large. Try a model that can see images (Claude, GPT, Gemini).'
    : hints[res.status]
  return [`Model API error ${res.status}${detail ? `: ${detail}` : '.'}`, hint].filter(Boolean).join(' ')
}

function upstreamMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    const message = e.message ?? e.detail ?? e.error
    if (typeof message === 'string') return message
    if (message && typeof message === 'object') return upstreamMessage(message)
  }
  return JSON.stringify(error).slice(0, 600)
}

function dbError(error: { message: string; code?: string }): HttpError {
  console.error('chat: database error', error)
  const hint = error.code === 'PGRST205' || error.code === '42P01'
    ? ' Did you run supabase/schema.sql (and the upgrade files)?'
    : error.code === '42501'
    ? ' Check the grants and policies from supabase/schema.sql.'
    : ''
  return new HttpError(500, `Database error: ${error.message}${hint}`)
}

function titleFrom(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length === 0) return 'New chat'
  return chars.length > 60 ? `${chars.slice(0, 57).join('').trimEnd()}…` : chars.join('')
}

/** Postgres text can't hold NUL characters. */
function clean(value: string): string {
  return value.replaceAll('\u0000', '')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function waitUntil(promise: Promise<unknown>) {
  // Keeps the function alive until the reply is saved, even if the browser disconnects.
  try {
    ;(globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(promise)
  } catch { /* not running on Supabase (e.g. local tests) */ }
}
