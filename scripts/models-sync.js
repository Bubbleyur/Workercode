#!/usr/bin/env node
// models-sync.js — refresh the office model catalog from a gateway.
//
//   npm run models:sync            # sync 9router (if it has a key) + Zen
//   npm run models:sync -- opencode
//   npm run models:sync -- 9router
//   node lib/models.js             # just print the merged catalog
//
// Zen needs no API key for its free tier; 9router does. A failure on one
// gateway never blocks the other.

import { syncModels, loadAllModels, modelSummary, gatewayState } from '../lib/models.js'

const only = process.argv[2]
const targets = only ? [only] : ['opencode', '9router']

console.log('')
for (const provider of targets) {
  const g = gatewayState()[provider]
  if (!g) { console.log(`  ${provider}: unknown gateway`); continue }
  const r = await syncModels(provider)
  if (r.error) {
    console.log(`  ${provider.padEnd(9)} skipped — ${r.error}`)
  } else {
    console.log(`  ${provider.padEnd(9)} ${String(r.count).padStart(3)} models (${r.free} free) from ${g.baseURL}`)
  }
}

const rows = loadAllModels()
const s = modelSummary()
console.log(`\n  catalog: ${s.available} usable models (${s.free} free, ${s.retired} retired) from ${s.sources.join(', ')}\n`)
