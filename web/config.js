// ─────────────────────────────────────────────────────────────────────────────
// Fill these in from Supabase Dashboard → Project Settings → API Keys.
// Both values are safe to publish: your data is protected by Row Level
// Security and your model API key lives only in the Edge Function secrets.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://vrmdgbspgizhgzvlnmjq.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_9BOfFizIFRBz-rGiP1nVMg_WNbxPU5X' // or the legacy "anon" key

export const APP_NAME = 'Chat'

// Show "Create an account" on the sign-in screen. Set to false once your own
// account exists (and turn off sign-ups in Supabase → Authentication).
export const ALLOW_SIGN_UP = true

// The models in the picker. The first one is the default.
// `id` must match your provider's model name exactly (these are GutsAI ids,
// with LLM_BASE_URL = https://api.gutsai.id/v1). `group` is optional.
export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Anthropic' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Anthropic' },
  { id: 'claude-fable-5.1', label: 'Claude Fable 5.1', group: 'Anthropic' },
  { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', group: 'Anthropic' },
  { id: 'claude-opus-4.7', label: 'Claude Opus 4.7', group: 'Anthropic' },

  { id: 'gpt-6-astra', label: 'GPT-6 Astra', group: 'OpenAI' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', group: 'OpenAI' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', group: 'OpenAI' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', group: 'OpenAI' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', group: 'OpenAI' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenAI' },
  { id: 'gpt-5.5', label: 'GPT-5.5', group: 'OpenAI' },

  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', group: 'Google' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', group: 'Google' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', group: 'Google' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', group: 'Google' },

  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', group: 'DeepSeek' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', group: 'DeepSeek' },
  { id: 'deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro (0813)', group: 'DeepSeek' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'DeepSeek' },
  { id: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash (0731)', group: 'DeepSeek' },

  { id: 'grok-4.6', label: 'Grok 4.6', group: 'xAI' },
  { id: 'grok-4.5', label: 'Grok 4.5', group: 'xAI' },

  { id: 'kimi-k3', label: 'Kimi K3', group: 'Moonshot' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', group: 'Moonshot' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', group: 'Moonshot' },

  { id: 'glm-5.3', label: 'GLM-5.3', group: 'Zhipu' },
  { id: 'glm-5.3-flashx', label: 'GLM-5.3 FlashX', group: 'Zhipu' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', group: 'Zhipu' },
  { id: 'glm-5.2', label: 'GLM-5.2', group: 'Zhipu' },

  { id: 'qwen-3.8-max', label: 'Qwen 3.8 Max', group: 'Qwen' },
  { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B', group: 'Qwen' },
  { id: 'qwen-3.7-max', label: 'Qwen 3.7 Max', group: 'Qwen' },
  { id: 'qwen-3.7-plus', label: 'Qwen 3.7 Plus', group: 'Qwen' },

  { id: 'minimax-m3', label: 'MiniMax M3', group: 'MiniMax' },
  { id: 'minimax-m2.7', label: 'MiniMax M2.7', group: 'MiniMax' },

  { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', group: 'Xiaomi' },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', group: 'Xiaomi' },

  { id: 'hy4-preview', label: 'Hunyuan 4 (preview)', group: 'Tencent' },
  { id: 'hy3-preview', label: 'Hunyuan 3 (preview)', group: 'Tencent' },

  { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3', group: 'Meta' },

  { id: 'nemotron-3-ultra', label: 'Nemotron 3 Ultra · free', group: 'NVIDIA' },
  { id: 'nemotron-3-super', label: 'Nemotron 3 Super · free', group: 'NVIDIA' },
  { id: 'nemotron-3.5-lightning', label: 'Nemotron 3.5 Lightning · free', group: 'NVIDIA' },
  { id: 'nemotron-3-nano-omni', label: 'Nemotron 3 Nano Omni · free', group: 'NVIDIA' },

  { id: 'laguna-s2.1', label: 'Laguna S2.1 · free', group: 'Other' },
  { id: 'laguna-xs2.1', label: 'Laguna XS2.1 · free', group: 'Other' },
  { id: 'ling-3.0-flash-fin', label: 'Ling 3.0 Flash Fin · free', group: 'Other' },
]
