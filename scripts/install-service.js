#!/usr/bin/env node
// install-service.js — register Big Pickle as a 24/7 OS service so it survives
// reboots without any terminal open.
//   Linux   -> systemd units (bigpickle-server, bigpickle-orchestrator, optional bridges)
//   Windows -> NSSM services (BigPickleServer, BigPickleOrchestrator, optional bridges)
//   npm run install:service [-- --user <name>]
//
// Run the wizard first:  node index.js --wizard

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, loadSettings, ensureDirs, ENV_FILE } from '../lib/state.js'
import { ensureAllWorkspaces } from '../lib/workspaces.js'
import { opencodeBin } from '../lib/server.js'
const args = process.argv.slice(2)
const serviceUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : null
const isWin = process.platform === 'win32'
const isRoot = !isWin && (process.getuid?.() === 0)

function nodeExe () { return process.execPath }

function envFileContent () {
  let lines = []
  if (fs.existsSync(ENV_FILE)) lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
  const out = lines.filter(l => l.trim() && !l.trim().startsWith('#'))
  return out.join('\n') + '\n'
}

function settings () { return ensureAllWorkspaces(loadSettings(true)) }

async function main () {
  const s = settings()
  ensureDirs()
  if (isWin) await installWindows(s)
  else await installLinux(s)
  console.log('\n  Installed as OS services. Manage with:')
  console.log(isWin
    ? '    nssm status BigPickleServer · nssm restart BigPickleServer'
    : '    systemctl status bigpickle  ·  systemctl restart bigpickle')
}

// ---------------------------------------------------------------- Linux ----
async function installLinux (s) {
  const run = (cmd) => spawnSync(cmd, { shell: true, stdio: 'inherit' })
  const user = serviceUser || (isRoot ? 'bigpickle' : undefined)
  if (user && isRoot) {
    const probe = spawnSync('id', ['-u', user], { shell: false, encoding: 'utf8' })
    if (probe.status !== 0) run(`useradd -r -m -s /bin/bash ${user}`)
  }
  const envPath = '/etc/bigpickle.env'
  fs.writeFileSync(envPath, envFileContent())
  if (!user) fs.chmodSync(envPath, 0o600)

  const unitDir = '/etc/systemd/system'
  const mk = (name, body) => fs.writeFileSync(path.join(unitDir, name + '.service'), body.join('\n') + '\n')

  const common = [
    `[Unit]`,
    `Description=Big Pickle ${'office'}`
  ]
  const svc = [
    ...common.slice(0, 2),
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    user ? `User=${user}` : `# run as invoking user`,
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=${opencodeBin()} serve --hostname ${s.hostname || '127.0.0.1'} --port ${s.port}`,
    `Restart=always`,
    `RestartSec=3`,
    `StandardOutput=append:${path.join(ROOT, 'runs', 'server.log')}`,
    `StandardError=inherit`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`
  ]
  mk('bigpickle-server', svc)

  const orch = [
    ...common.slice(0, 2),
    `After=bigpickle-server.service`,
    `Requires=bigpickle-server.service`,
    ``,
    `[Service]`,
    user ? `User=${user}` : ``,
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=${nodeExe()} ${path.join(ROOT, 'bin', 'orchestrator.js')}`,
    `Restart=always`,
    `RestartSec=3`,
    `StandardOutput=append:${path.join(ROOT, 'runs', 'orchestrator.log')}`,
    `StandardError=inherit`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`
  ]
  mk('bigpickle-orchestrator', orch)

  const bridges = []
  if (s.integrations.discord?.enabled) bridges.push(['bigpickle-discord', 'bridges/discord.js'])
  if (s.integrations.whatsapp?.enabled) bridges.push(['bigpickle-whatsapp', 'bridges/whatsapp.js'])
  for (const [unit, script] of bridges) {
    mk(unit, [
      ...common.slice(0, 2),
      `After=bigpickle-server.service`,
      ``,
      `[Service]`,
      user ? `User=${user}` : ``,
      `WorkingDirectory=${ROOT}`,
      `EnvironmentFile=${envPath}`,
      `ExecStart=${nodeExe()} ${path.join(ROOT, script)}`,
      `Restart=always`,
      `RestartSec=5`,
      `StandardOutput=append:${path.join(ROOT, 'runs', unit + '.log')}`,
      `StandardError=inherit`,
      ``,
      `[Install]`,
      `WantedBy=multi-user.target`
    ])
  }

  run('systemctl daemon-reload')
  run('systemctl enable --now bigpickle-server bigpickle-orchestrator' + (bridges.length ? ' ' + bridges.map(b => b[0]).join(' ') : ''))
  console.log('  systemd units: bigpickle-server, bigpickle-orchestrator' + (bridges.length ? ' + ' + bridges.map(b => b[0]).join(', ') : ''))
}

// -------------------------------------------------------------- Windows ----
async function installWindows (s) {
  let nssm = process.env.NSSM || ''
  if (!nssm) {
    const local = path.join(ROOT, 'tools', 'nssm', 'nssm.exe')
    if (fs.existsSync(local)) nssm = local
  }
  if (!nssm) {
    console.log('  NSSM not found — downloading into tools/nssm …')
    fs.mkdirSync(path.join(ROOT, 'tools'), { recursive: true })
    const zip = path.join(ROOT, 'tools', 'nssm.zip')
    const url = 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip'
    const res = await fetch(url)
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zip.replace(/'/g, "''")}', '${path.join(ROOT, 'tools', 'nssm').replace(/'/g, "''")}', $true); ` +
      `Get-ChildItem '${path.join(ROOT, 'tools', 'nssm')}' -Recurse -Filter nssm.exe | Select-Object -First 1 -ExpandProperty FullName | Out-File '${path.join(ROOT, 'tools', 'nssm.path').replace(/'/g, "''")}'`
    ], { stdio: 'inherit' })
    nssm = fs.readFileSync(path.join(ROOT, 'tools', 'nssm.path'), 'utf8').trim()
  }
  if (!fs.existsSync(nssm)) { console.error('NSSM unavailable at ' + nssm); process.exit(1) }

  const node = nodeExe()
  // On Windows a .cmd shim can't be NSSM's Application — resolve the .exe,
  // otherwise go through cmd.exe /c.
  const opencode = opencodeBin()
  const serverApp = /\.(cmd|bat)$/i.test(opencode) ? 'cmd.exe' : opencode
  const serverArgs = /\.(cmd|bat)$/i.test(opencode)
    ? ['/c', opencode, 'serve', '--hostname', s.hostname || '127.0.0.1', '--port', String(s.port)]
    : ['serve', '--hostname', s.hostname || '127.0.0.1', '--port', String(s.port)]
  const env = envFileContent().split('\n').filter(Boolean)
  const appEnv = env.length ? ['AppEnvironmentExtra', ...env] : []

  const mk = (name, exe, appArgs, { logs = true } = {}) => {
    const args = [name, exe, ...appArgs]
    if (appEnv.length) args.push(...appEnv)
    args.push('AppDirectory', ROOT)
    args.push('Start', 'SERVICE_AUTO_START')
    if (logs) {
      args.push('AppStdout', path.join(ROOT, 'runs', name.toLowerCase() + '.out.log'))
      args.push('AppStderr', path.join(ROOT, 'runs', name.toLowerCase() + '.err.log'))
    }
    args.push('AppRotateFiles', '1')
    args.push('AppRotateBytes', '10485760')
    spawnSync(nssm, ['install'].concat(args), { stdio: 'inherit' })
    spawnSync(nssm, ['set', name, 'AppExit', 'Default', 'Restart'], { stdio: 'inherit' })
  }

  mk('BigPickleServer', serverApp, serverArgs)
  mk('BigPickleOrchestrator', node, [path.join(ROOT, 'bin', 'orchestrator.js')])
  if (s.integrations.discord?.enabled) mk('BigPickleDiscord', node, [path.join(ROOT, 'bridges', 'discord.js')])
  if (s.integrations.whatsapp?.enabled) mk('BigPickleWhatsApp', node, [path.join(ROOT, 'bridges', 'whatsapp.js')])

  console.log('  NSSM services: BigPickleServer, BigPickleOrchestrator (+ bridges)')
}

main().catch(e => { console.error(e); process.exit(1) })