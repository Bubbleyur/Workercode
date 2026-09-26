#!/usr/bin/env node
// status.js — one command to see the whole office: server, orchestrator, jobs.
//   npm run status    (or: node scripts/status.js)

import path from 'node:path'
import fs from 'node:fs'
import { loadSettings, readPassword, serverUrl, LOG_DIR, ROOT } from '../lib/state.js'
import { ensureAllWorkspaces } from '../lib/workspaces.js'
import { OpenCodeClient } from '../lib/api.js'

async function main () {
  const s = ensureAllWorkspaces(loadSettings(true))
  const client = new OpenCodeClient(serverUrl(s), readPassword())

  console.log('── Big Pickle office status ────────────────────')
  console.log(`theme     ${s.theme} · ${(s.workers || []).length} digital workers · ${(s.divisions || []).length} divisions · ${s.parallel ?? 2} parallel`)

  try {
    const info = await client.health()
    console.log(`server    OK  ${info.urls?.[0] || serverUrl(s)}  (version ${info.version})`)
  } catch (e) {
    console.log(`server    DOWN  — ${e.message}`)
    console.log('start it with:  node index.js   or   npm run install:service')
    process.exitCode = 1
  }

  const healthPort = s.healthPort || 8099
  try {
    const r = await fetch(`http://127.0.0.1:${healthPort}/health`)
    const h = await r.json()
    console.log(`orchestrator OK  active=${h.active}/${h.workers} queued=${h.queued} jobs=${h.jobs}`)
    const jobs = await (await fetch(`http://127.0.0.1:${healthPort}/jobs`)).json()
    const wanted = ['running', 'queued', 'failed', 'done'].map(st => ({
      st, list: jobs.jobs.filter(j => j.status === st)
    })).filter(x => x.list.length)
    for (const { st, list } of wanted) {
      console.log(`  ${st.padEnd(8)} ${list.map(j => `${j.workspaceID}:${j.name}`).join(', ') || '-'}`)
    }
  } catch {
    console.log(`orchestrator DOWN — status http://127.0.0.1:${healthPort}/health not answering`)
    process.exitCode = 1
  }
  console.log('────────────────────────────────────────────────')
  console.log(`web session  ${serverUrl(s)}   (user: opencode / pass in config/server.password)`)
}

main()