// logger.js — timestamped console + file logging. Each process writes to its
// own file under runs/ (runs/launcher.log, runs/orchestrator.log, ...) so
// `npm run logs` can tail them individually.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOG_DIR } from './state.js'

function entryName () {
  try {
    const p = process.argv[1]
    if (p) {
      const base = path.basename(p, path.extname(p))
      if (base === 'index') return 'launcher'
      return base
    }
  } catch {}
  return 'launcher'
}

const file = path.join(LOG_DIR, `${entryName()}.log`)

function line (level, args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const out = `[${ts}] [${level}] ${msg}`
  process.stdout.write(out + '\n')
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(file, out + '\n')
  } catch {}
}

export const log = { info: (...a) => line('info', a), warn: (...a) => line('warn', a), error: (...a) => line('error', a), ok: (...a) => line('ok', a) }
export const logFile = file