// state.js — load/save settings.json and a tiny .env loader.
// The data dir is the project root; everything Big Pickle needs lives there.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_DIR = path.join(ROOT, 'config')
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
export const ENV_FILE = path.join(ROOT, '.env')
export const PASSWORD_FILE = path.join(CONFIG_DIR, 'server.password')
export const LOG_DIR = path.join(ROOT, 'runs')

export const DEFAULTS = {
  port: 4096,
  hostname: '127.0.0.1',
  parallel: 2,
  retries: 1,
  openBrowser: true,
  pollMs: 3000,
  healthPort: 8099,
  model: '',
  provider: '',
  theme: 'company office',
  divisions: [],
  roles: [],
  workers: [],
  workspaces: [],
  // pipeline evaluation defaults (overridable per build / in the panel)
  evalThreshold: 70,
  evalRetries: 2,
  previewBase: 8100,
  evalTimeoutMs: 60000,
  integrations: {
    discord: { enabled: false, token: '' },
    whatsapp: { enabled: false, method: 'qr', token: '', phoneNumberId: '' }
  }
}

let cached = null

export function ensureDirs () {
  for (const d of [
    CONFIG_DIR,
    LOG_DIR,
    path.join(ROOT, 'inbox'),
    path.join(ROOT, 'apps'),
    path.join(ROOT, 'runs'),
    path.join(ROOT, 'skills'),
    path.join(ROOT, 'config', 'whatsapp-session')
  ]) fs.mkdirSync(d, { recursive: true })
}

/** Load `.env` key=value lines into process.env (never overwrite existing). */
export function loadEnv () {
  if (!fs.existsSync(ENV_FILE)) return
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}

export function loadSettings (fresh = false) {
  if (cached && !fresh) return cached
  ensureDirs()
  loadEnv()
  let data = {}
  if (fs.existsSync(SETTINGS_FILE)) {
    try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } catch { data = {} }
  }
  cached = deepMerge(structuredClone(DEFAULTS), data)
  return cached
}

export function saveSettings (settings) {
  ensureDirs()
  cached = settings
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
}

export function serverUrl (settings = loadSettings()) {
  const host = settings.hostname || '127.0.0.1'
  const port = settings.port || 4096
  const base = `http://${host}:${port}`
  return base
}

export function readPassword () {
  try { return fs.readFileSync(PASSWORD_FILE, 'utf8').trim() } catch { return process.env.BIGPICKLE_TOKEN || '' }
}

export function writePassword (pw) {
  if (pw && pw !== '') fs.writeFileSync(PASSWORD_FILE, pw.trim() + '\n')
}

function deepMerge (base, override) {
  for (const k of Object.keys(override)) {
    const v = override[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], v)
    } else {
      base[k] = v
    }
  }
  return base
}