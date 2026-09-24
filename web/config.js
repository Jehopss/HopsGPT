// ─────────────────────────────────────────────────────────────────────────────
// Fill these in from Supabase Dashboard → Project Settings → API Keys.
// Both values are safe to publish: your data is protected by Row Level
// Security and your model API key lives only in the Edge Function secrets.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_...' // or the legacy "anon" key

export const APP_NAME = 'Chat'

// Show "Create an account" on the sign-in screen. Set to false once your own
// account exists (and turn off sign-ups in Supabase → Authentication).
export const ALLOW_SIGN_UP = true

// The models in the picker. The first one is the default.
// These ids are for OpenRouter (one key → all of them). If your key is from a
// single provider, use that provider's ids instead (see README).
export const MODELS = [
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]
