#!/usr/bin/env node
// 9router-sync.js — import the 9router model catalog into config/9router.models.json
// and print a ready-to-paste "providers.9router" block for opencode.json(c).
//
//   npm run 9router:sync     (or: node scripts/9router-sync.js)

import fs from 'node:fs'
import path from 'node:path'
import { saveModelCatalog, MODEL_CATALOG } from '../lib/workspaces.js'
import { loadSettings, ENV_FILE, ROOT } from '../lib/state.js'

function envValue (k) {
  try {
    if (process.env[k]) return process.env[k]
    if (fs.existsSync(ENV_FILE)) {
      for (const l of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        if (l.startsWith(`${k}=`)) return l.slice(k.length + 1).trim()
      }
    }
  } catch {}
  return ''
}

async function main () {
  const settings = loadSettings(true)
  const base = (settings['9router']?.baseURL || envValue('NINEROUTER_BASE_URL') || 'https://api.9router.com/v1').replace(/\/$/, '')
  const key = settings['9router']?.apiKey || envValue('NINEROUTER_API_KEY')

  if (!key) {
    console.error('NINEROUTER_API_KEY is not set. Add it to .env or run the wizard.')
    process.exit(1)
  }

  console.log(`Fetching model list from ${base}/models ...`)
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) {
    console.error(`9router returned ${res.status}`)
    try { console.error((await res.text()).slice(0, 400)) } catch {}
    process.exit(1)
  }
  const json = await res.json()

  // /models often returns { data: [...] } or a bare array.
  const raw = Array.isArray(json) ? json : json.data || json.models || []
  const models = raw.map(m => String(m.id || m.name || m)).filter(Boolean)

  saveModelCatalog(models, base)
  console.log(`Saved ${models.length} models -> ${path.relative(ROOT, MODEL_CATALOG)}\n`)

  console.log('Paste this into opencode.jsonc under "providers":\n')
  const providerBlock = {
    "9router": {
      env: ['NINEROUTER_API_KEY'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: base, apiKey: '{env:NINEROUTER_API_KEY}' },
      models: Object.fromEntries(models.map(m => [m, { name: m }]))
    }
  }
  console.log(JSON.stringify(providerBlock, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })