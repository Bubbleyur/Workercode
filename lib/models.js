#!/usr/bin/env node
// models.js — the office model catalog: every model a worker can be assigned.
//
// Two gateways ship in the box:
//   9router        — the 9router.com gateway, one key, many providers
//   opencode (Zen) — OpenCode's own gateway, ref `opencode/<model-id>`; the
//                    free tier is a genuinely free way to run the whole office
// plus any custom ref the CEO types in by hand.
//
// Nothing here is a hard requirement: a missing key or an offline sync just
// falls back to the bundled catalog, so the office always starts.

import fs from 'node:fs'
import path from 'node:path'
import { ROOT, CONFIG_DIR, loadSettings, saveSettings, envValue, upsertEnv } from './state.js'
import { ROLE_MODEL_DEFAULTS } from './model.js'

export const NINE_BASE = 'https://api.9router.com/v1'
export const ZEN_BASE = 'https://opencode.ai/zen/v1'

export const NINE_CATALOG_FILE = path.join(CONFIG_DIR, '9router.models.json')
export const ZEN_CATALOG_FILE = path.join(CONFIG_DIR, 'zen.models.json')
export const CUSTOM_CATALOG_FILE = path.join(CONFIG_DIR, 'custom.models.json')

/** Legacy name for the 9router catalog, still used by scripts/9router-sync.js. */
export const MODEL_CATALOG = NINE_CATALOG_FILE

/** Provider id used for the bundled Zen refs, matching OpenCode's own naming. */
export const ZEN_PROVIDER = 'opencode'

// ── OpenCode Zen ────────────────────────────────────────────────────────────
// Snapshot of https://opencode.ai/zen/v1/models (2026-09). The endpoint is
// public, so `syncModels('opencode')` refreshes this at runtime; the snapshot
// is what keeps the picker useful offline and on a cold first boot.

/** Free models — these cost nothing, so a fresh office can run 24/7. */
export const ZEN_FREE = [
  'big-pickle',
  'space-bunny-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
  'deepseek-v4-flash-free',
  'jev-1.13-free'
]

/** Retired on Zen — listed so nobody assigns them, hidden from the pickers. */
export const ZEN_RETIRED = [
  'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
  'gpt-5.2-codex', 'claude-sonnet-4', 'gemini-3-pro', 'minimax-m2.1',
  'minimax-m2.5', 'glm-5', 'kimi-k2', 'kimi-k2.5'
]

/** Every Zen model id, free + retired included, for the full reference table. */
export const ZEN_ALL = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
  'claude-haiku-4-5', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash',
  'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3-flash',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro',
  'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex-spark', 'gpt-5.3-codex',
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex-max', 'gpt-5.1-codex',
  'gpt-5.1-codex-mini', 'gpt-5', 'gpt-5-codex', 'gpt-5-nano', 'grok-build-0.1',
  'grok-4.7', 'grok-4.6', 'grok-4.5', 'muse-spark-1.3', 'muse-spark-1.2',
  'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp', 'glm-5.3-flash', 'glm-5.3', 'glm-5.2',
  'glm-5.1', 'glm-5', 'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'kimi-k3',
  'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'qwen3.8-max', 'qwen3.8-flash',
  'qwen3.6-plus', 'qwen3.5-plus', 'jev-1.13', 'jev-1.13-free', 'big-pickle',
  'deepseek-v4-flash-free', 'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free', 'mimo-v2.6-flash-free', 'space-bunny-free',
  'mimo-v2.5-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free'
]

/** Role defaults live in model.js (the pure data module) so both agree. */
const ROLE_MODELS = ROLE_MODEL_DEFAULTS

const FALLBACK_MODELS = [
  '9router/oc/union-alpha',
  '9router/oc/muse-spark-1.3-contributor-free',
  '9router/oc/muse-spark-1.2-contributor-free',
  '9router/sekai/cx/gpt-6-astra',
  '9router/sekai/tencent/hy4-preview'
]

// ── catalog storage ─────────────────────────────────────────────────────────

function readJSON (file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  return null
}

function writeJSON (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

/** Model ids discovered from 9router (written by scripts/9router-sync.js). */
export function loadModelCatalog () {
  const d = readJSON(NINE_CATALOG_FILE)
  if (!d) return []
  if (Array.isArray(d) && d.length) return d
  if (Array.isArray(d.models) && d.models.length) return d.models
  return []
}

export function saveModelCatalog (models, baseURL) {
  writeJSON(NINE_CATALOG_FILE, { baseURL, fetchedAt: new Date().toISOString(), models })
}

/** The CEO's own refs, added from the panel. */
export function loadCustomModels () {
  const d = readJSON(CUSTOM_CATALOG_FILE)
  return Array.isArray(d?.models) ? d.models : []
}

export function addCustomModel (ref, name) {
  const models = loadCustomModels()
  if (!models.some(m => m.ref === ref)) models.push({ ref, name: name || ref })
  writeJSON(CUSTOM_CATALOG_FILE, { updatedAt: new Date().toISOString(), models })
  return models
}

export function removeCustomModel (ref) {
  const models = loadCustomModels().filter(m => m.ref !== ref)
  writeJSON(CUSTOM_CATALOG_FILE, { updatedAt: new Date().toISOString(), models })
  return models
}

/** Live Zen catalog if synced, else the bundled snapshot. */
export function loadZenCatalog () {
  const d = readJSON(ZEN_CATALOG_FILE)
  const ids = Array.isArray(d?.models) && d.models.length ? d.models : ZEN_ALL
  return { ids, baseURL: d?.baseURL || ZEN_BASE, fetchedAt: d?.fetchedAt || null, live: Boolean(d?.fetchedAt) }
}

// ── catalog assembly ────────────────────────────────────────────────────────

const isFreeRef = ref => {
  const tail = String(ref).split('/').pop() || ''
  return ZEN_FREE.includes(tail) || /-free$/.test(tail)
}

const isRetiredRef = ref => {
  const tail = String(ref).split('/').pop() || ''
  return ZEN_RETIRED.includes(tail)
}

/** `9router/oc/union-alpha` → `oc/union-alpha`; plain ids pass through. */
function prettyRef (ref) {
  const parts = String(ref).split('/')
  return parts.length > 2 ? parts.slice(1).join('/') : ref
}

/**
 * The merged catalog every picker reads: 9router + Zen + custom refs.
 * Deduplicated by ref, free models surfaced first, retired ones flagged.
 */
export function loadAllModels () {
  const out = []
  const seen = new Set()
  const push = (ref, source, extra = {}) => {
    ref = String(ref || '').trim()
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    out.push({
      ref,
      source,
      name: extra.name || prettyRef(ref),
      free: extra.free ?? isFreeRef(ref),
      retired: extra.retired ?? isRetiredRef(ref),
      provider: ref.split('/')[0]
    })
  }

  for (const m of loadCustomModels()) push(m.ref, 'custom', { free: m.free, name: m.name })
  for (const m of loadZenCatalog().ids) push(`${ZEN_PROVIDER}/${m}`, 'zen')
  for (const m of loadModelCatalog()) push(typeof m === 'string' ? m : (m.providerID ? `${m.providerID}/${m.modelID || m.id}` : m.id), '9router')
  if (!out.length) for (const m of FALLBACK_MODELS) push(m, 'builtin')

  out.sort((a, b) => (b.free - a.free) || a.ref.localeCompare(b.ref))
  return out
}

/** Just the refs, ordered for a picker: free first, retired last. */
export function allModelRefs () {
  const rows = loadAllModels()
  return [...rows.filter(r => !r.retired).map(r => r.ref), ...rows.filter(r => r.retired).map(r => r.ref)]
}

/** The free subset — what the CEO gets for zero cost. */
export function freeModelRefs () {
  return loadAllModels().filter(r => r.free && !r.retired).map(r => r.ref)
}

export function defaultModelRefs () {
  return [...new Set(Object.values(ROLE_MODELS))]
}

export function roleModel (role) {
  return ROLE_MODEL_DEFAULTS[role] || ROLE_MODEL_DEFAULTS.builder
}

export { ROLE_MODEL_DEFAULTS }

// ── gateway configuration ───────────────────────────────────────────────────

/**
 * Current gateway wiring, secrets reduced to a boolean + masked preview.
 * `.env` wins over settings.json so a key set by the wizard is never lost.
 */
export function gatewayState () {
  const s = loadSettings()
  const nineBase = (s['9router']?.baseURL || envValue('NINEROUTER_BASE_URL') || NINE_BASE).replace(/\/$/, '')
  const nineKey = s['9router']?.apiKey || envValue('NINEROUTER_API_KEY') || ''
  const zenBase = (s.gateways?.zenBaseURL || envValue('OPENCODE_BASE_URL') || ZEN_BASE).replace(/\/$/, '')
  const zenKey = s.gateways?.zenApiKey || envValue('OPENCODE_API_KEY') || ''
  return {
    '9router': { baseURL: nineBase, hasKey: Boolean(nineKey), keyPreview: mask4(nineKey), models: loadModelCatalog().length },
    opencode: { baseURL: zenBase, hasKey: Boolean(zenKey), keyPreview: mask4(zenKey), models: loadZenCatalog().ids.length }
  }
}

function mask4 (s) {
  if (!s) return ''
  return s.length <= 8 ? '••••••••' : s.slice(0, 3) + '•••' + s.slice(-3)
}

/** Persist a gateway change to settings.json + .env. Never echoes the secret. */
export function saveGateway (provider, patch = {}) {
  const s = loadSettings(true)
  s.gateways = s.gateways || {}
  if (provider === '9router') {
    s['9router'] = s['9router'] || {}
    if (patch.baseURL) { s['9router'].baseURL = patch.baseURL.replace(/\/$/, ''); upsertEnv('NINEROUTER_BASE_URL', s['9router'].baseURL) }
    if (patch.apiKey) { s['9router'].apiKey = patch.apiKey; upsertEnv('NINEROUTER_API_KEY', patch.apiKey) }
  } else if (provider === 'opencode') {
    if (patch.baseURL) { s.gateways.zenBaseURL = patch.baseURL.replace(/\/$/, ''); upsertEnv('OPENCODE_BASE_URL', s.gateways.zenBaseURL) }
    if (patch.apiKey) { s.gateways.zenApiKey = patch.apiKey; upsertEnv('OPENCODE_API_KEY', patch.apiKey) }
  } else {
    return { error: `unknown gateway "${provider}"` }
  }
  saveSettings(s)
  return { ok: true, gateways: gatewayState() }
}

/**
 * Refresh one gateway's live model list. Zen is public and works with no key;
 * 9router needs its key. Either way a failure is reported, never thrown at boot.
 */
export async function syncModels (provider) {
  const g = gatewayState()[provider]
  if (!g) return { error: `unknown gateway "${provider}"` }
  const base = g.baseURL
  const headers = {}
  if (provider === '9router') {
    if (!g.hasKey) return { error: '9router needs an API key — add one in Gateways first' }
    headers.Authorization = `Bearer ${envValue('NINEROUTER_API_KEY') || (loadSettings()['9router']?.apiKey || '')}`
  }
  let json
  try {
    const res = await fetch(`${base}/models`, { headers })
    if (!res.ok) return { error: `${provider} returned HTTP ${res.status}` }
    json = await res.json()
  } catch (e) {
    return { error: `${provider} unreachable: ${e.message}` }
  }
  const raw = Array.isArray(json) ? json : (json.data || json.models || [])
  const ids = raw.map(m => String(m.id || m.name || m)).filter(Boolean)
  if (!ids.length) return { error: `${provider} returned no models` }

  if (provider === '9router') saveModelCatalog(ids, base)
  else writeJSON(ZEN_CATALOG_FILE, { baseURL: base, fetchedAt: new Date().toISOString(), models: ids })

  return { ok: true, provider, count: ids.length, free: ids.filter(isFreeRef).length }
}

// ── office tool pages ───────────────────────────────────────────────────────
// One list the panel renders as clickable cards, so every page the office
// depends on is one click away instead of a bookmarked URL.

export const TOOL_PAGES = [
  // gateways
  { group: 'Gateways', label: '9router console', url: 'https://console.9router.com', hint: 'create or top up a 9router API key' },
  { group: 'Gateways', label: '9router docs', url: 'https://9router.com/docs', hint: 'gateway API reference' },
  { group: 'Gateways', label: 'OpenCode Zen', url: 'https://opencode.ai/zen', hint: 'Zen gateway — free + paid models, one key' },
  { group: 'Gateways', label: 'Zen live model list', url: ZEN_BASE + '/models', hint: 'the exact JSON this office syncs from' },
  { group: 'Gateways', label: 'OpenCode provider setup', url: 'https://opencode.ai/docs/providers', hint: 'auth, custom endpoints, local models' },
  { group: 'Gateways', label: 'OpenCode models', url: 'https://opencode.ai/docs/models', hint: 'model refs, variants, per-model options' },
  // configuration
  { group: 'Config', label: 'Agents reference', url: 'https://opencode.ai/docs/agents', hint: 'primary/subagent — what the 8 office agents map to' },
  { group: 'Config', label: 'Config reference', url: 'https://opencode.ai/docs/config', hint: 'opencode.jsonc — the office config file' },
  { group: 'Config', label: 'Permissions', url: 'https://opencode.ai/docs/permissions', hint: 'what office agents may do unattended' },
  { group: 'Config', label: 'Skills', url: 'https://opencode.ai/docs/skills', hint: 'pack extra instructions into a worker' },
  { group: 'Config', label: 'OpenCode home', url: 'https://opencode.ai', hint: 'releases, changelog, downloads' }
]

/** Internal pages, resolved against the live server origin at render time. */
export const OFFICE_PAGES = [
  { group: 'Office', label: 'Control panel', path: '/panel', hint: 'this page' },
  { group: 'Office', label: 'Roof cam', path: '/office', hint: 'live worker desks' },
  { group: 'Office', label: 'Previews', path: '/api/previews', hint: 'every deployed app the office runs' },
  { group: 'Office', label: 'Build queue', path: '/api/jobs', hint: 'job states and stage progress' },
  { group: 'Office', label: 'Worker roster', path: '/api/workers', hint: 'roles, divisions, models' },
  { group: 'Office', label: 'Evaluation log', path: '/api/evaluations', hint: 'every score, pass and retry' },
  { group: 'Office', label: 'Event feed', path: '/api/events', hint: 'what the office just did' },
  { group: 'Office', label: 'Health', path: '/health', hint: 'parallel builds and worker count' }
]

/** One-line summary for the wizard and the panel header. */
export function modelSummary () {
  const rows = loadAllModels()
  const live = rows.filter(r => !r.retired)
  return {
    total: rows.length,
    available: live.length,
    free: live.filter(r => r.free).length,
    retired: rows.length - live.length,
    sources: [...new Set(rows.map(r => r.source))]
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  // `node lib/models.js` prints the catalog — handy for checking a fresh install.
  const rows = loadAllModels()
  const s = modelSummary()
  console.log(`\n  ${rows.length} models (${s.free} free) from: ${s.sources.join(', ')}`)
  for (const r of rows) {
    const tag = r.free ? 'free' : r.retired ? 'retired' : 'paid '
    console.log(`   ${tag}  ${r.ref.padEnd(48)} ${r.source}`)
  }
  console.log('')
}
