#!/usr/bin/env node
// logs.js — tail the office logs.
//   npm run logs            # all logs
//   npm run logs -- server  # only the opencode server log

import path from 'node:path'
import fs from 'node:fs'
import { ROOT, LOG_DIR } from '../lib/state.js'

const name = process.argv[2]
const files = [
  ['launcher', path.join(LOG_DIR, 'launcher.log')],
  ['server', path.join(LOG_DIR, 'server.log')],
  ['orchestrator', path.join(LOG_DIR, 'orchestrator.log')],
  ['discord', path.join(LOG_DIR, 'bigpickle-discord.log')],
  ['whatsapp', path.join(LOG_DIR, 'bigpickle-whatsapp.log')]
].filter(([k]) => !name || k === name)

for (const [key, file] of files) {
  console.log(`\n── ${key} (${file}) ──`)
  if (!fs.existsSync(file)) { console.log('(no log yet)'); continue }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  console.log(lines.slice(-50).join('\n'))
}