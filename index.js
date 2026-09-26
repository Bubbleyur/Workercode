#!/usr/bin/env node
// index.js — Big Pickle launcher. Run this and the whole office comes up:
//
//   node index.js            # wizard on first run, then start everything
//   node index.js --wizard   # re-run the questionnaire only
//   node index.js --no-browser --no-orchestrator --no-bridges
//
// Stacks: opencode serve (localhost web session) + app orchestrator
// + Discord/WhatsApp bridges. All processes stay alive together and shut
// down cleanly together.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, SETTINGS_FILE, loadSettings, saveSettings, PASSWORD_FILE, readPassword } from './lib/state.js'
import { ensureAllWorkspaces, workspaceModelRef, THEME } from './lib/workspaces.js'
import { runWizard, settingsSummary } from './lib/wizard.js'
import { startServer, opencodeBin } from './lib/server.js'
import { log, logFile } from './lib/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const ONLY_WIZARD = args.includes('--wizard')
const NO_BROWSER = args.includes('--no-browser')
const NO_ORCH = args.includes('--no-orchestrator')
const NO_BRIDGES = args.includes('--no-bridges')

function die (msg) { console.error(msg); process.exit(1) }

function which (cmd) {
  const isWin = process.platform === 'win32'
  const suffixes = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const suf of suffixes) {
      const p = path.join(dir, cmd + suf)
      try { if (fs.statSync(p).isFile()) return p } catch {}
    }
  }
  return null
}

function openBrowser (url) {
  if (NO_BROWSER) return
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

async function ensureOpenCode () {
  const bin = opencodeBin()
  const ok = path.isAbsolute(bin) ? fs.existsSync(bin) : Boolean(which(bin))
  if (ok) return true
  console.log('\n  OpenCode is not on PATH. Install it, then re-run:')
  if (process.platform === 'win32') console.log('    npm install -g @opencode/cli')
  else console.log('    curl -fsSL https://opencode.ai/v2/install | bash\n    (or: npm install -g @opencode/cli)')
  return false
}

async function main () {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Big Pickle launcher — 24/7 OpenCode office.')
    console.log('Usage: node index.js [--wizard] [--no-browser] [--no-orchestrator] [--no-bridges]')
    return
  }

  const firstRun = !fs.existsSync(SETTINGS_FILE)
  if (firstRun || ONLY_WIZARD) {
    if (ONLY_WIZARD) console.log('re-running wizard…')
    await runWizard()
    if (ONLY_WIZARD) return
  }

  const settings = ensureAllWorkspaces(loadSettings(true))
  saveSettings(settings)

  if (!(await ensureOpenCode())) return

  console.log('\n  ── Big Pickle office ───────────────────────────────')
  console.log(`  theme      ${settings.theme || THEME}`)
  console.log(`  settings   ${settingsSummary(settings)}`)
  console.log('  ─────────────────────────────────────────────────────')

  // 1) the 24/7 server (localhost web session)
  const { url, password } = await startServer(settings, { logStream: fs.createWriteStream(path.join(ROOT, 'runs', 'server.log'), { flags: 'a' }) })

  // web credentials for the browser session
  console.log(`\n  Web session  ${url}`)
  console.log(`  Username     opencode`)
  console.log(`  Password     ${password}`)
  if (!password) console.log('  (password file: config/server.password)')
  openBrowser(url)

  // 2) divisions + worker table
  console.log('\n  Divisions:')
  for (const d of settings.divisions || []) {
    console.log(`    ${d.id.padEnd(14)} ${d.name || d.id}${d.description ? ' — ' + d.description : ''}`)
  }
  console.log('\n  Digital Workers:')
  for (const w of settings.workers || []) {
    console.log(`    ${w.id.padEnd(14)} ${(w.role || '').padEnd(12)} ${(w.division || 'core').padEnd(10)} ${workspaceModelRef(w) || w.model}${w.status !== 'active' ? ` (${w.status})` : ''}`)
  }

  // 3) orchestrator + bridges
  const children = []
  const spawnChild = (name, script) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      stdio: 'inherit',
      env: { ...process.env, BIGPICKLE_ROOT: ROOT }
    })
    child.on('exit', code => log.warn(`${name} exited (code=${code})`))
    children.push(child)
    return child
  }

  if (!NO_ORCH) spawnChild('orchestrator', 'bin/orchestrator.js')
  else log.info('orchestrator disabled (--no-orchestrator)')

  if (!NO_BRIDGES) {
    if (settings.integrations.discord?.enabled || process.env.DISCORD_BOT_TOKEN) spawnChild('discord bridge', 'bridges/discord.js')
    if (settings.integrations.whatsapp?.enabled || process.env.WHATSAPP_TOKEN) spawnChild('whatsapp bridge', 'bridges/whatsapp.js')
  }

  console.log(`\n  Status:     http://localhost:${settings.healthPort || 8099}/health`)
  console.log(`  Control:    http://localhost:${settings.healthPort || 8099}/panel   (workers · new build · jobs · evaluation)`)
  console.log(`  Office cam: http://localhost:${settings.healthPort || 8099}/   (animated rooftop view of the workers)`)
  console.log(`  Logs:       ${logFile}`)
  console.log('\n  Office is open 24/7. Ctrl+C to close.')

  const shutdown = () => {
    log.info('shutting down…')
    for (const c of children) { try { c.kill() } catch {} }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => {
  console.error('\n' + (e.stack || e.message))
  process.exit(1)
})