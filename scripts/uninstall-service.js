#!/usr/bin/env node
// uninstall-service.js — stop and remove the OS services.
//   npm run uninstall:service

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../lib/state.js'

const isWin = process.platform === 'win32'

function run (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin })
  return r.status
}

async function main () {
  if (isWin) {
    let nssm = process.env.NSSM
    const p = path.join(ROOT, 'tools', 'nssm.path')
    if (!nssm && fs.existsSync(p)) nssm = fs.readFileSync(p, 'utf8').trim()
    if (!nssm) { console.error('NSSM not found — remove services manually:  nssm remove BigPickleServer confirm'); process.exit(1) }
    for (const svc of ['BigPickleWhatsApp', 'BigPickleDiscord', 'BigPickleOrchestrator', 'BigPickleServer']) {
      run(nssm, ['remove', svc, 'confirm'])
    }
  } else {
    run('systemctl', ['disable', '--now', 'bigpickle-server', 'bigpickle-orchestrator', 'bigpickle-discord', 'bigpickle-whatsapp'])
    for (const u of ['bigpickle-server', 'bigpickle-orchestrator', 'bigpickle-discord', 'bigpickle-whatsapp']) {
      fs.rmSync(`/etc/systemd/system/${u}.service`, { force: true })
    }
    run('systemctl', ['daemon-reload'])
  }
  console.log('Services removed. Project files, config and sessions are untouched.')
}

main()