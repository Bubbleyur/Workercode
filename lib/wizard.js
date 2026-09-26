// wizard.js — interactive questionnaire ("questionary") run on first launch.
// Asks for the localhost port, model gateway (9router / direct), divisions +
// the Digital Workers team (role + model per worker), and optional Discord /
// WhatsApp integrations (bot token, or WhatsApp QR).
//
// Navigate with ↑/↓ + Enter; multi-selects use Space + Enter. All choices are
// radio (●/○) or checkbox ([✓]/·) lists so the CLI feels tidy and safe.

import fs from 'node:fs'
import { ENV_FILE, loadSettings, saveSettings, ROOT } from './state.js'
import { ensureAllWorkspaces, loadModelCatalog, defaultModelRefs, THEME, SUGGESTED_WORKERS, DIV_COLORS, slugId } from './workspaces.js'
import { ask, askSecret, menu, multiselect, section, endInteractive, cyan, dim, bold, green, yellow } from './prompt.js'

function upsertEnv (key, value) {
  if (!value) return
  let lines = []
  if (fs.existsSync(ENV_FILE)) lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
  const out = lines.filter(l => !l.startsWith(key + '='))
  out.push(`${key}=${value}`)
  fs.writeFileSync(ENV_FILE, out.join('\n') + '\n')
}

function envValue (k) {
  if (process.env[k]) return process.env[k]
  try {
    if (fs.existsSync(ENV_FILE)) {
      for (const l of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        if (l.startsWith(`${k}=`)) return l.slice(k.length + 1).trim()
      }
    }
  } catch {}
  return ''
}

/** Ask for a whole number and re-ask (with a friendly warning) until valid. */
async function askNumber (question, dflt, min, max) {
  for (;;) {
    const raw = await ask(question, { default: dflt })
    const n = parseInt(raw, 10)
    if (Number.isInteger(n) && n >= min && n <= max) return n
    console.log('  ' + yellow('⚠') + ' ' + dim(`must be a whole number from ${min} to ${max} — try again`))
  }
}

export function maskSecret (s) {
  if (!s) return ''
  return s.length <= 8 ? '••••••••' : s.slice(0, 3) + '•••' + s.slice(-3)
}

const ROLES = [
  { id: 'architect', label: 'Architect', hint: 'planning, design, specs' },
  { id: 'builder', label: 'Builder', hint: 'implementation, coding' },
  { id: 'reviewer', label: 'Reviewer', hint: 'code review + evaluation score' },
  { id: 'tester', label: 'Tester', hint: 'QA, automated validation' },
  { id: 'deployer', label: 'Deployer', hint: 'build, packaging, preview' },
  { id: 'data-scientist', label: 'Data Scientist', hint: 'analysis, ML' },
  { id: 'support', label: 'Support', hint: 'docs, triage' },
  { id: 'ceo-assistant', label: 'CEO Assistant', hint: "your right hand — reports, comms, notifications" }
]

const SUGGESTED = SUGGESTED_WORKERS
const VARIANTS = [
  { label: 'medium', value: 'medium', hint: 'balanced (recommended)' },
  { label: 'high', value: 'high', hint: 'best quality, slower' },
  { label: 'low', value: 'low', hint: 'fast, cheap' },
  { label: 'default', value: 'default', hint: 'gateway default' }
]
const OTHER = Symbol.for('other')

export async function runWizard () {
  console.log('')
  console.log('  ' + bold('Big Pickle setup wizard') + '  —  ' + dim('answers build the whole office'))
  console.log(dim('  ↑/↓ move · Enter pick · Space toggle · Esc/Ctrl+C quits'))
  console.log('')

  const s = loadSettings(true)

  // ── 1 · model gateway ────────────────────────────────────────────────────
  section('Model gateway — where the brains come from', 1, 6)
  const gateway = await menu('Which model gateway do you want to use?', [
    { label: '9router', value: '9router', hint: 'many models, one key — recommended' },
    { label: 'Direct provider', value: 'direct', hint: 'anthropic, openai, google, …' },
    { label: 'Already configured', value: 'existing', hint: 'skip key setup, use opencode auth' }
  ], { defaultIndex: 0, hint: `theme: ${THEME}` })

  if (gateway === '9router') {
    const key = s['9router']?.apiKey || envValue('NINEROUTER_API_KEY')
    if (key) console.log('  ' + green('✓') + ' 9router key already present (' + maskSecret(key) + ')')
    else upsertEnv('NINEROUTER_API_KEY', await askSecret('9router API key (sk-…)'))
    const base = await ask('9router base URL', { default: s['9router']?.baseURL || envValue('NINEROUTER_BASE_URL') || 'https://api.9router.com/v1' })
    s['9router'] = { apiKey: key || envValue('NINEROUTER_API_KEY'), baseURL: base }
    upsertEnv('NINEROUTER_BASE_URL', base)
    console.log(dim('  tip: npm run 9router:sync imports the exact model catalog'))
  } else if (gateway === 'direct') {
    const provider = await menu('Which provider?', Object.entries(KEY_ENV).map(([id, env]) => ({ label: id, value: env, hint: env })))
    const key = await askSecret(`Paste your ${Object.keys(KEY_ENV).find(k => KEY_ENV[k] === provider)} API key`)
    if (key) upsertEnv(provider, key)
    s.provider = Object.keys(KEY_ENV).find(k => KEY_ENV[k] === provider)
    console.log(dim('  or add more later with `opencode auth login`'))
  }

  // ── 2 · localhost session ────────────────────────────────────────────────
  section('Localhost session — where the web UI lives', 2, 6)
  s.port = await askNumber('Port for the localhost session', s.port || 4096, 1, 65535)
  s.hostname = await ask('Bind address', { default: s.hostname || '127.0.0.1' })
  s.parallel = await askNumber('Builds to run in parallel', s.parallel ?? (typeof s.workers === 'number' ? s.workers : 2), 1, 16)
  console.log('  ' + green('✓') + ' ' + dim('session → ') + `http://${s.hostname}:${s.port}`)
  console.log('  ' + dim('credentials: user ') + bold('opencode') + dim(' + password (printed on start)'))

  // ── 3 · digital workers ────────────────────────────────────────────────
  section('Digital Workers — your team (everyone reports to you, the CEO)', 3, 6)

  const divCount = await askNumber('How many divisions (teams)?', s.divisions?.length || 1, 1, 8)
  const divisions = []
  for (let i = 0; i < divCount; i++) {
    console.log('')
    console.log('  ' + dim('───') + ' ' + yellow(`Division ${i + 1}/${divCount}`) + ' ' + dim('───'))
    const name = await ask(`Division name`, { default: i === 0 ? (s.divisions?.[0]?.name || 'Core') : `Division ${i + 1}`, hint: i === 0 ? 'the main team' : '' })
    divisions.push({ id: slugId(String(name)) || `division-${i + 1}`, name, description: '', color: DIV_COLORS[i % DIV_COLORS.length] })
  }

  const count = await askNumber('How many Digital Workers?', s.workers?.length || 5, 1, 20)
  const catalog = loadModelCatalog()
  const pool = catalog.length ? catalog.map(m => (m.providerID ? `${m.providerID}/${m.modelID || m.id}` : m.id)) : defaultModelRefs()
  const modelOptions = () => [
    ...pool.map((m, i) => ({ label: m, value: m, hint: i === 0 ? 'recommended' : '' })),
    { label: '✎ custom model ref…', value: OTHER }
  ]

  const workerList = []
  const usedIds = new Set()
  for (let i = 0; i < count; i++) {
    console.log('')
    console.log('  ' + dim('───') + ' ' + yellow(`Worker ${i + 1}/${count}`) + ' ' + dim('───'))
    const name = await ask(`Worker name`, { default: SUGGESTED[i] || `Worker ${i + 1}` })
    const division = await menu('Which division (team)?', divisions.map(d => ({ label: d.name, value: d.id })), { defaultIndex: 0 })
    const role = await menu('Role (its job in the SDLC pipeline)', ROLES.map(r => ({ label: r.label, value: r.id, hint: r.hint })), { defaultIndex: Math.min(i, ROLES.length - 1) })
    const roleLabel = ROLES.find(r => r.id === role)?.label || role

    let model = await menu('Model (9router) for this worker', modelOptions(), { defaultIndex: Math.min(i, pool.length - 1), hint: 'refresh with npm run 9router:sync' })
    if (model === OTHER) {
      for (;;) {
        model = (await ask('Model ref (e.g. 9router/oc/union-alpha#high)')).trim()
        if (model && model.includes('/')) break
        console.log('  ' + yellow('⚠') + ' ' + dim('a model ref needs "provider/model" — try again'))
      }
    }
    const variant = await menu('Router variant', VARIANTS, { defaultIndex: 0 })

    let id = slugId(String(name)) || `worker-${i + 1}`
    let n = 2
    while (usedIds.has(id)) id = `${id}-${n++}`
    usedIds.add(id)

    workerList.push({
      id,
      name,
      role,
      division,
      model,
      variant,
      description: `${name} — ${roleLabel}`,
      status: 'active'
    })
  }
  s.theme = THEME
  s.divisions = divisions
  s.workers = workerList

  // ── 4 · messaging integrations ───────────────────────────────────────────
  section('Messaging — talk to the office from chat', 4, 6)
  const chosen = await multiselect('Enable integrations', [
    { label: 'Discord', value: 'discord' },
    { label: 'WhatsApp', value: 'whatsapp' }
  ], { hint: 'Space to toggle, Enter to continue' })

  if (chosen.includes('discord')) {
    const token = await askSecret('Discord bot token')
    s.integrations.discord = { enabled: true, token }
    upsertEnv('DISCORD_BOT_TOKEN', token)
    console.log('  ' + green('✓') + ' Discord enabled ' + dim('— invite the bot to a server and message it'))
    const notify = (await ask('Discord channel ID for CEO notifications', { hint: 'a numeric channel id (right-click channel → Copy Channel ID). Empty = notifications off', default: '' })).trim()
    if (notify) { s.integrations.discord.notifyChannelId = notify; upsertEnv('DISCORD_NOTIFY_CHANNEL_ID', notify) }
  } else {
    s.integrations.discord = { enabled: false, token: '' }
  }

  if (chosen.includes('whatsapp')) {
    const method = await menu('WhatsApp login method', [
      { label: 'QR code', value: 'qr', hint: 'pair right away — scan with your phone' },
      { label: 'Cloud API token', value: 'token', hint: 'Meta / WhatsApp Business API' }
    ], { defaultIndex: 0 })
    if (method === 'token') {
      const token = await askSecret('WhatsApp Cloud API access token')
      const phoneNumberId = await ask('WhatsApp phone number ID')
      s.integrations.whatsapp = { enabled: true, method: 'token', token, phoneNumberId }
      upsertEnv('WHATSAPP_TOKEN', token)
      upsertEnv('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId)
    } else {
      s.integrations.whatsapp = { enabled: true, method: 'qr', token: '', phoneNumberId: '' }
      console.log('  ' + green('✓') + ' WhatsApp QR mode ' + dim('— a QR code prints on next start, scan it once'))
      const ceoJid = (await ask('Your WhatsApp contact for CEO notifications', { hint: 'e.g. 628123456789@s.whatsapp.net. Empty = notifications off', default: '' })).trim()
      if (ceoJid) { s.integrations.whatsapp.ceoJid = ceoJid; upsertEnv('WHATSAPP_CEO_JID', ceoJid) }
    }
  } else {
    s.integrations.whatsapp = { enabled: false, method: 'qr', token: '', phoneNumberId: '' }
  }

  // ── 5 · review + save ────────────────────────────────────────────────────
  section('Review — here is your office', 5, 6)
  printPlan(s)
  ensureAllWorkspaces(s)
  saveSettings(s)

  section('Launch', 6, 6)
  console.log('  ' + green('✓') + ' saveSettings → config/settings.json + .env')
  console.log('')
  console.log('  ' + bold('Next:'))
  console.log('    ' + cyan('node index.js'))
  console.log(`    → open ${bold(`http://localhost:${s.port}`)} · user ` + bold('opencode') + dim(' / password printed on start'))
  console.log('    → or run it as a 24/7 service: ' + yellow('npm run install:service'))
  console.log('')
  await endInteractive()
  return s
}

/** Tidy summary panel mirroring every decision back. */
function printPlan (s) {
  const divisions = s.divisions || []
  const workers = s.workers || []
  const rows = [
    ['Port', `${s.port}  ${cyan(`http://${s.hostname || '127.0.0.1'}:${s.port}`)}`],
    ['Parallel', `${s.parallel || s.workers || 0} build(s) in parallel`],
    ['Divisions', `${divisions.length} team(s) — ${divisions.map(d => d.name).join(', ')}`],
    ['Workers', `${workers.length} digital worker(s)`]
  ]
  for (const w of workers) {
    const role = ROLES.find(r => r.id === w.role)?.label || w.role
    rows.push([`  ${w.name}`, `${dim(role)} · ${dim(w.division || 'core')} · ${w.model}${w.variant && w.variant !== 'default' ? '#' + w.variant : ''}`])
  }
  rows.push(['9router', s['9router']?.baseURL ? 'on ' + dim(maskSecret(s['9router']?.apiKey)) : (s.provider ? `on (${s.provider})` : 'existing auth')])
  rows.push(['Discord', s.integrations.discord?.enabled ? green('✓ on') : dim('off')])
  rows.push(['WhatsApp', s.integrations.whatsapp?.enabled ? green(`✓ on (${s.integrations.whatsapp.method})`) : dim('off')])

  const labelW = Math.max(...rows.map(r => r[0].length))
  console.log(rows.map(([k, v]) => '  ' + k.padEnd(labelW) + '  ' + v).join('\n'))
}

export function settingsSummary (s) {
  const parts = [`port=${s.port}`, `parallel=${s.parallel ?? s.workers}`, `theme=${s.theme || 'company office'}`]
  if (s.divisions?.length) parts.push(`divisions=${s.divisions.map(d => d.id).join(',')}`)
  if (s.workers?.length) parts.push(`workers=${s.workers.map(w => w.id).join(',')}`)
  if (s.provider) parts.push(`provider=${s.provider}`)
  if (s['9router']?.baseURL) parts.push('9router=on')
  parts.push(s.integrations.discord.enabled ? 'discord=on' : 'discord=off')
  parts.push(s.integrations.whatsapp.enabled ? `whatsapp=on(${s.integrations.whatsapp.method})` : 'whatsapp=off')
  return parts.join(' · ')
}

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY'
}

export { ROOT }