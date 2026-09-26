#!/usr/bin/env node
// pack-repo.js — pack the project into build/ as a standalone, pushable repo.
//
//   npm run pack:repo          # pack only
//   npm run pack:repo -- --git # pack, then git init + first commit (no remote, no push)
//
// build/ becomes the project root: `cd build && git add -A && git commit` can be
// pushed on its own without ever carrying the working office along. Secrets,
// run artifacts and node_modules are never copied, and a push-ready .gitignore
// is written so a later run inside build/ cannot leak anything either.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../lib/state.js'

const DEST = path.join(ROOT, 'build')
const DIST = path.join(DEST, '_dist')

// Project source (work) — copied into build/.
const INCLUDE = [
  'index.js', 'index.cmd', 'index.sh',
  'package.json', 'AGENTS.md', 'README.md', 'QUICKSTART.mdx',
  '.env.example', 'opencode.jsonc', '.gitattributes',
  'lib', 'bin', 'bridges', 'scripts', 'templates', 'public', 'inbox',
  'config/opencode.global.jsonc'
]

// Never copied: secrets, user data, junk, and the output folder itself.
const EXCLUDE = new Set([
  '.env', 'node_modules', 'build', '.git', 'workspaces', 'apps', 'runs',
  'config/settings.json', 'config/server.password', 'config/bridge-sessions.json',
  'config/9router.models.json', 'config/zen.models.json', 'config/custom.models.json',
  'config/whatsapp-session',
  'tools', '.DS_Store', 'Thumbs.db'
])

// Written over the copied .gitignore: the pushable repo must ignore every
// runtime artifact, not just the few the working office produces.
const GITIGNORE = `# ---- Big Pickle: secrets + runtime state never belong in git ----

# secrets (created by the wizard / on first run)
.env
config/settings.json
config/server.password
config/bridge-sessions.json
config/whatsapp-session/
config/9router.models.json
config/zen.models.json
config/custom.models.json

# office runtime state
runs/
workspaces/
apps/
skills/
tools/
node_modules/
build/
_dist/
*.log

# OS junk
.DS_Store
Thumbs.db
`

function copyTree (src, dst) {
  if (fs.statSync(src).isFile()) {
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

/** Move the publish artifacts into build/_dist/ so build/ is the repo root. */
function stashDist () {
  if (!fs.existsSync(DEST)) return []
  const moved = []
  fs.mkdirSync(DIST, { recursive: true })
  for (const name of ['bigpickle-vps', 'bigpickle-vps.zip']) {
    const from = path.join(DEST, name)
    if (!fs.existsSync(from)) continue
    fs.rmSync(path.join(DIST, name), { recursive: true, force: true })
    fs.renameSync(from, path.join(DIST, name))
    moved.push(name)
  }
  return moved
}

function main () {
  fs.mkdirSync(DEST, { recursive: true })
  const moved = stashDist()
  if (moved.length) console.log(`  dist      ${moved.join(', ')} → build/_dist/`)

  let files = 0
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel)
    if (!fs.existsSync(src)) {
      console.warn(`  ! missing source: ${rel}`)
      continue
    }
    // Replace whatever this entry produced last time (never touches _dist/).
    fs.rmSync(path.join(DEST, rel), { recursive: true, force: true })
    files += copyTree(src, path.join(DEST, rel))
  }

  fs.writeFileSync(path.join(DEST, '.gitignore'), GITIGNORE)

  const report = path.join(ROOT, 'runs', 'BUILD_REPORT.md')
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(DEST, 'BUILD_REPORT.md'))

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const git = process.argv.includes('--git')

  console.log(`\n  Big Pickle repo pack`)
  console.log(`  version   ${pkg.name} v${pkg.version}`)
  console.log(`  files     ${files} copied → build/`)
  console.log(`  gitignore written (secrets + runs/workspaces/apps ignored)`)

  if (!git) {
    console.log(`  git       skipped — pass --git to init + commit\n`)
    return
  }

  const run = (args, quiet) => spawnSync('git', args, { cwd: DEST, stdio: quiet ? 'pipe' : 'inherit' })
  const fresh = !fs.existsSync(path.join(DEST, '.git'))
  if (fresh) {
    const init = run(['init', '-b', 'main'])
    if (init.status !== 0) { console.warn('  git       git init failed — skipped'); return }
  }
  if (run(['add', '-A'], !fresh).status !== 0) { console.warn('  git       git add failed'); return }

  const message = `${pkg.name} v${pkg.version} — Digital Workers office with CEO assistant`
  if (fresh) {
    const commit = run(['commit', '-m', message])
    console.log(commit.status === 0 ? '  git       initial commit created (no remote, nothing pushed)\n' : '  git       commit failed\n')
    return
  }

  // Already a repo: amend our own last commit so re-packing never piles up
  // duplicate "initial commit" history for the CEO to push.
  const head = run(['log', '-1', '--pretty=%s'], true)
  const headMsg = (head.stdout || '').toString().trim()
  const amend = headMsg === message
    ? run(['commit', '--amend', '--no-edit'], true)
    : run(['commit', '-m', message], true)
  if (amend.status === 0) {
    console.log(`  git       ${amend.stdout.toString().trim().split('\n').pop() || 'committed'} (no remote, nothing pushed)\n`)
  } else {
    console.log('  git       nothing to commit — build/ already matches the source\n')
  }
}

main()
