#!/usr/bin/env node
// new-app.js — scaffold a new app folder into a workspace inbox.
// The orchestrator picks it up within seconds and a worker builds it 24/7.
//
//   npm run new-app -- engineering my-api
//   node scripts/new-app.js <workspace-or-name> <app-name>

import fs from 'node:fs'
import path from 'node:path'
import { ROOT, LOG_DIR, loadSettings } from '../lib/state.js'
import { ensureAllWorkspaces, workspacePath } from '../lib/workspaces.js'

const [, , wsArg = 'engineering', nameArg = ''] = process.argv

function main () {
  const settings = ensureAllWorkspaces(loadSettings(true))
  if (!nameArg) {
    console.error('Usage: node scripts/new-app.js <workspace-id|department-name> <app-name>')
    console.error('Workspaces: ' + settings.workspaces.map(w => w.id).join(', '))
    process.exit(1)
  }

  let ws = settings.workspaces.find(w => w.id === wsArg || w.name?.toLowerCase() === wsArg.toLowerCase())
  if (!ws) {
    console.error(`Unknown workspace "${wsArg}". Choose one of: ${settings.workspaces.map(w => w.id).join(', ')}`)
    process.exit(1)
  }

  const safe = String(nameArg).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'app'
  const inbox = path.join(workspacePath(ws), 'inbox')
  const target = path.join(inbox, safe)
  if (fs.existsSync(target)) {
    console.error(`${target} already exists.`)
    process.exit(1)
  }
  fs.mkdirSync(target, { recursive: true })

  const files = {
    manifest: {
      name: safe,
      description: 'What should this app do?',
      stack: 'node, react, python, ...',
      model: '',   // optional: override the workspace model, e.g. "9router/oc/union-alpha#high"
      agent: '',   // optional: override the workspace role
      prompt: 'Build this app: implement it, add a README and minimal tests, then write BUILD_REPORT.md.'
    },
    README: `# ${safe}\n\nDescribe the application here. The ${ws.name} workspace (${ws.role} role) will build it.\n`,
    AGENTS: `# ${safe} — build instructions\n\nYou work for Big Pickle. Your user is the CEO — this folder is their order.\n- Build is via the ${ws.name} workspace.\n- Keep all work inside this folder.\n- Finish by writing BUILD_REPORT.md.\n`
  }

  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(files.manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'README.md'), files.README)
  fs.writeFileSync(path.join(target, 'AGENTS.md'), files.AGENTS)

  console.log(`Created ${path.relative(ROOT, target)}/`)
  console.log('The orchestrator will queue it automatically. Watch: npm run status')
}

main()