#!/usr/bin/env node
// build-publish.js — assemble a clean, publish-ready copy of Big Pickle:
//
//   npm run build:publish
//
// Copies the project (minus secrets, run artifacts, node_modules) into
// build/bigpickle-vps/ and zips it to build/bigpickle-vps.zip.
// Everything the end user needs to run the wizard + office ships inside.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../lib/state.js'

const OUT = path.join(ROOT, 'build', 'bigpickle-vps')
const ZIP = path.join(ROOT, 'build', 'bigpickle-vps.zip')

// Files/dirs that are PROJECT SOURCE (work), not runtime state (user data).
const INCLUDE = [
  'index.js', 'index.cmd', 'index.sh',
  'package.json', 'AGENTS.md', 'README.md', 'QUICKSTART.mdx',
  '.env.example', '.gitignore', 'opencode.jsonc',
  'lib', 'bin', 'bridges', 'scripts', 'templates', 'public', 'inbox',
  'config/opencode.global.jsonc'
]

// Anything never allowed into a publish build (secrets / user data / junk).
const EXCLUDE = new Set([
  '.env', 'node_modules', 'build', '.git', 'workspaces', 'apps', 'runs',
  'config/settings.json', 'config/server.password', 'config/bridge-sessions.json',
  'config/9router.models.json', 'config/whatsapp-session',
  'tools', '.DS_Store', 'Thumbs.db'
])

function copyTree (src, dst) {
  const st = fs.statSync(src)
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    return 1
  }
  let n = 0
  for (const entry of fs.readdirSync(src)) {
    if (EXCLUDE.has(entry)) continue
    n += copyTree(path.join(src, entry), path.join(dst, entry))
  }
  return n
}

function main () {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.rmSync(ZIP, { force: true })
  fs.mkdirSync(OUT, { recursive: true })

  let files = 0
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel)
    if (!fs.existsSync(src)) {
      console.warn(`  ! missing source: ${rel}`)
      continue
    }
    // EXPLICIT exclusions inside included dirs
    if (EXCLUDE.has(path.basename(rel)) || EXCLUDE.has(rel)) continue
    files += copyTree(src, path.join(OUT, rel))
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const meta = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    files: files,
    node: pkg.engines?.node || '>=18',
    start: 'node index.js',
    wizard: 'node index.js --wizard',
    officeCam: 'open http://127.0.0.1:8099/'
  }
  fs.writeFileSync(path.join(OUT, 'BUILD_INFO.json'), JSON.stringify(meta, null, 2) + '\n')

  // Carry the build report inside the published copy (if present).
  const report = path.join(ROOT, 'runs', 'BUILD_REPORT.md')
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(OUT, 'BUILD_REPORT.md'))

  console.log(`\n  Big Pickle publish build`)
  console.log(`  version   ${meta.name} v${meta.version}`)
  console.log(`  files     ${files} copied → build/bigpickle-vps/`)
  console.log(`  secrets   excluded (${[...EXCLUDE].filter(e => e !== 'node_modules').length} rules applied)`)

  // zip with system tar (bsdtar) — available on Windows 10+ and all Unix.
  const res = spawnSync('tar', ['-a', '-c', '-f', ZIP, 'bigpickle-vps'], { cwd: path.dirname(OUT), stdio: 'pipe' })
  if (res.status === 0 && fs.existsSync(ZIP)) {
    console.log(`  zip       build/bigpickle-vps.zip (${(fs.statSync(ZIP).size / 1024).toFixed(1)} KB)`)
  } else {
    console.warn(`  zip       skipped — tar unavailable; build/bigpickle-vps/ is ready to copy`)
  }
  console.log('')
}

main()