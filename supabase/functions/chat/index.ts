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

const MAX_INPUT_CHARS = 100_000
const MAX_INSTRUCTIONS_CHARS = 20_000
const MAX_MEMORIES = 150
const MEMORY_CONTEXT_CHARS = 8_000
const CHECKPOINT_EVERY_MS = 2_000
const HEARTBEAT_EVERY_MS = 15_000

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
  message?: unknown
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
  role: 'user' | 'assistant'
  content: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

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
  | { type: 'meta'; conversation_id: string; title: string; created: boolean; user_message_id: string; model: string }
  | { type: 'thinking' }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
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
  const text = typeof body.message === 'string' ? clean(body.message).trim() : ''
  if (!text) throw new HttpError(400, 'Message is empty.')
  if (text.length > MAX_INPUT_CHARS) {
    throw new HttpError(413, `Message is too long (max ${MAX_INPUT_CHARS.toLocaleString('en')} characters).`)
  }
  const model = pickModel(body.model)

  // 3. Find the chat, or create it on the first message
  let conversation: { id: string; title: string; system_prompt: string }
  const isNew = !body.conversation_id
  if (!isNew) {
    const id = String(body.conversation_id)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Chat not found.')
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
      .insert({ user_id: userId, title: titleFrom(text), model, system_prompt: instructions })
      .select('id, title, system_prompt')
      .single()
    if (error) throw dbError(error)
    conversation = data
  }

  // 4. Save the user's message
  const { data: userMessage, error: insertError } = await db
    .from('chat_messages')
    .insert({ conversation_id: conversation.id, user_id: userId, role: 'user', content: text })
    .select('id')
    .single()
  if (insertError) throw dbError(insertError)

  // 5. Build the context: instructions, memory, past chats, recent history
  const [historyResult, settings, memories] = await Promise.all([
    db
      .from('chat_messages')
      .select('role, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(CONTEXT_MAX_MESSAGES),
    loadSettings(db, userId),
    loadMemories(db, userId),
  ])
  if (historyResult.error) throw dbError(historyResult.error)
  const history = fitHistory((historyResult.data as HistoryRow[]).reverse())
  const memoryOn = settings.v2 && settings.prefs.memory !== false
  const pastChats = settings.v2 && settings.prefs.referenceChats === true
    ? await searchPastChats(db, text, conversation.id)
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
    meta: {
      type: 'meta',
      conversation_id: conversation.id,
      title: conversation.title,
      created: isNew,
      user_message_id: userMessage.id,
      model,
    },
    messages,
    saveWith,
    afterReply: memoryOn && text.length >= 8
      ? async (reply) => {
        const result = await runMemoryUpdate({
          client: saveWith,
          userId,
          model: MEMORY_MODEL || model,
          memories,
          maxAdds: 5,
          task: `Latest exchange:\nUser: ${text.slice(0, 4000)}\nAssistant: ${stripArtifacts(reply).slice(0, 1500)}`,
        })
        return result.added + result.updated + result.deleted
      }
      : undefined,
  })
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

/** Keep the newest messages that fit the budget, oldest first. */
function fitHistory(rows: HistoryRow[]): ChatMessage[] {
  const kept: HistoryRow[] = []
  let chars = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const length = rows[i].content.length
    if (kept.length > 0 && chars + length > CONTEXT_MAX_CHARS) break
    kept.unshift(rows[i])
    chars += length
  }
  // Some providers require the first turn to be the user's, and dislike two
  // turns in a row from the same role (e.g. after a failed reply). Tidy up.
  while (kept.length > 0 && kept[0].role !== 'user') kept.shift()
  const merged: ChatMessage[] = []
  for (const row of kept) {
    const last = merged[merged.length - 1]
    if (last && last.role === row.role) last.content += `\n\n${row.content}`
    else merged.push({ role: row.role, content: row.content })
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

        const saver = createSaver(opts)
        let content = ''
        let usage: Usage | null = null
        let finishReason: string | null = null
        let errorMessage: string | null = null
        let thinkingSent = false

        try {
          const res = await callModel(opts.model, opts.messages, upstreamAbort.signal)
          if (!res.ok || !res.body) {
            errorMessage = await describeUpstreamError(res)
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
        const promptChars = opts.messages.reduce((n, m) => n + m.content.length, 0)
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
function createSaver(opts: { userId: string; model: string; conversationId: string; saveWith: SupabaseClient }) {
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
          ...fields,
        })
        .select('id')
        .single()
      if (error) throw error
      messageId = data.id
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

async function describeUpstreamError(res: Response): Promise<string> {
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
  return [`Model API error ${res.status}${detail ? `: ${detail}` : '.'}`, hints[res.status]].filter(Boolean).join(' ')
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
    ? ' Did you run supabase/schema.sql (and upgrade-v2.sql)?'
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
