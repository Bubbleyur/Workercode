// server.js — spawn the 24/7 `opencode serve` process, capture its auth
// password, wait until /api/info is healthy, and keep the child around.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { writePassword, readPassword, loadSettings } from './state.js'
import { log } from './logger.js'
import { OpenCodeClient } from './api.js'

export function opencodeBin () {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  if (process.platform !== 'win32') return 'opencode'
  return whichOpenCodeExe() || 'opencode.cmd'
}

/** On Windows, the PATH entry is a .cmd shim; the real binary is an .exe in
 *  the npm package. Prefer it so we never have to go through cmd.exe. */
function whichOpenCodeExe () {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidates = [
      path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      path.join(dir, 'opencode.exe'),
      path.join(dir, '..', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    ]
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c } catch {}
    }
  }
  return ''
}

/**
 * Start `opencode serve` bound to the configured hostname/port.
 * Resolves with { proc, url, password } once the API answers /api/info.
 */
export async function startServer (settings = loadSettings(), { logStream = process.stdout } = {}) {
  const url = `http://${settings.hostname}:${settings.port}`
  const args = ['serve', '--hostname', String(settings.hostname), '--port', String(settings.port)]
  if (settings.cors && Array.isArray(settings.cors)) {
    for (const origin of settings.cors) args.push('--cors', origin)
  }

  log.info(`starting opencode serve -> ${url}`)
  const bin = opencodeBin()
  // A bare .cmd/.bat cannot be spawned directly on Windows — go through cmd.
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  const cmd = useShell ? 'cmd.exe' : bin
  const cargs = useShell ? ['/c', bin, ...args] : args
  const proc = spawn(cmd, cargs, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env, shell: false })

  let password = readPassword()
  proc.stdout.on('data', chunk => {
    const text = chunk.toString()
    if (logStream && logStream !== process.stdout) logStream.write(text)
    const m = text.match(/server password\s+(\S+)/)
    if (m && m[1]) {
      password = m[1]
      writePassword(m[1])
      log.info(`server password captured (authentication for web + API + bridges)`)
    }
  })

  proc.on('exit', (code, signal) => {
    log.warn(`opencode serve exited (code=${code} signal=${signal ?? 'none'})`)
  })

  // Wait for a healthy API response.
  const client = new OpenCodeClient(url, password || '')
  const deadline = Date.now() + 30000
  let health = null
  while (Date.now() < deadline) {
    if (password) client.password = password
    try {
      health = await client.health()
      break
    } catch (e) {
      // password may be still to arrive
      password = readPassword() || password
      client.password = password
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!health) {
    proc.kill()
    throw new Error(`Server on ${url} did not become healthy within 30s. Check the log above.`)
  }

  log.ok(`server healthy — ${health?.version ?? ''} at ${url}`)
  if (!password) log.warn('no server password captured from stdout; set BIGPICKLE_TOKEN or config/server.password')
  return { proc, url, password, client }
}