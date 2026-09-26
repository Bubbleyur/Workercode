#!/usr/bin/env node
// orchestrator.js — 24/7 Digital Workers factory. Every submitted build (a
// folder dropped in a worker's inbox/ or a POST to /api/builds) becomes an
// app that runs the Plan → Build → Review → Test → Deploy pipeline. Each
// stage is picked up by an active worker for the job's division, evaluated
// (auto checks + AI rubric), retried with critique, or paused for a human.
//
//   node bin/orchestrator.js                 (or: npm run orchestrator)
//   BIGPICKLE_DRY=1 node bin/orchestrator.js (no provider needed — QA mode)
//   BIGPICKLE_DRY=1 BIGPICKLE_DRY_FAIL=review ... (force needs-review path)
//
// Health: GET http://127.0.0.1:8099/health   GET /jobs   GET /workspaces
// API:    GET  /api/builds   POST /api/builds   POST /api/builds/:id/action
//         GET  /api/previews POST /api/previews/:id/stop
// Mutations require header `x-office-key: <config/server.password>`.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { OpenCodeClient } from '../lib/api.js'
import { loadSettings, saveSettings, serverUrl, readPassword, ROOT, LOG_DIR, ensureDirs } from '../lib/state.js'
import { ensureAllWorkspaces, workspacePath, workspaceModelRef, roleById, divisionById, slugId, validateWorker, DIV_COLORS, STAGES, STAGE_LABELS, loadAllModels, allModelRefs, defaultModelRefs, loadCustomModels, addCustomModel, removeCustomModel, gatewayState, saveGateway, syncModels, modelSummary, TOOL_PAGES, OFFICE_PAGES, CEO_ROLE } from '../lib/workspaces.js'
import { runPipeline } from '../lib/pipeline.js'
import { DryClient, dryRunScorer } from '../lib/dry.js'
import { log } from '../lib/logger.js'

const settings = ensureAllWorkspaces(loadSettings(true))
const DRY = process.env.BIGPICKLE_DRY === '1'
const realClient = new OpenCodeClient(serverUrl(settings), process.env.BIGPICKLE_TOKEN || readPassword())
const client = DRY ? new DryClient({ failStage: process.env.BIGPICKLE_DRY_FAIL }) : realClient
const POLL_MS = settings.pollMs || 3000
let WORKERS = settings.parallel || 2
const STATE_FILE = path.join(LOG_DIR, '.state.json')
const PREVIEWS_FILE = path.join(LOG_DIR, 'previews.json')

let jobs = [] // enriched jobs, see newJob()
let queue = []
let previews = [] // {id, name, dir, port, url, startedAt}

function loadState () {
  const raw = []
  try { raw.push(...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) } catch {}
  jobs = raw.map(j => normalizeJob(j))
}
function saveState () {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(jobs, null, 2))
}
function loadPreviews () {
  try { previews = JSON.parse(fs.readFileSync(PREVIEWS_FILE, 'utf8')) } catch { previews = [] }
}
function savePreviews () {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(PREVIEWS_FILE, JSON.stringify(previews, null, 2))
}

// ---- events (the CEO notification feed; bridges poll /api/events) ------------
const EVENTS_FILE = path.join(LOG_DIR, 'events.json')
let events = []
function loadEvents () { try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) } catch { events = [] } }
function saveEvents () {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(-400), null, 2))
  } catch {}
}
/** Record an office event and hand it to any bridge notifiers. */
function publishEvent (type, message, extra = {}) {
  const ev = { id: uniqId(), at: new Date().toISOString(), type, message, ...extra }
  events.push(ev)
  if (events.length > 400) events = events.slice(-400)
  saveEvents()
  for (const fn of bridgeNotifiers) { try { fn(ev) } catch {} }
  return ev
}

// ---- CEO assistant state (notices + reports under runs/ceo) ------------------
const CEO_DIR = path.join(LOG_DIR, 'ceo')
const CEO_FILE = path.join(CEO_DIR, 'state.json')
let ceo = { notices: [], reports: [] }
function loadCeo () {
  try { ceo = { notices: [], reports: [], ...JSON.parse(fs.readFileSync(CEO_FILE, 'utf8')) } } catch { ceo = { notices: [], reports: [] } }
}
function saveCeo () {
  try {
    fs.mkdirSync(CEO_DIR, { recursive: true })
    fs.writeFileSync(CEO_FILE, JSON.stringify(ceo, null, 2))
  } catch {}
}

function normalizeJob (j) {
  if (!j) return j
  j.evaluations = Array.isArray(j.evaluations) ? j.evaluations : []
  j.stageStatus = j.stageStatus || {}
  if (typeof j.stageCursor !== 'number') j.stageCursor = j.status === 'needs-review' ? Math.max(0, (j.stageCursor || 0)) : 0
  return j
}

function jobById (id) { return jobs.find(j => j.id === id) }

function uniqId () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }

/** The pipeline context passed to runPipeline(). */
function pipelineCtx () {
  return {
    client,
    settings,
    log: (...a) => log.info(...a),
    save: saveState,
    event: (type, message, extra) => publishEvent(type, message, extra),
    runScorer: DRY
      ? dryRunScorer
      : async (scorer, job, rubric) => {
        const session = await client.createSession({
          title: `[${job.id} evaluate] ${job.name}`,
          directory: job.dir,
          agent: scorer.role.agent || scorer.worker.role,
          model: workspaceModelRef(scorer.worker) || settings.model
        })
        return client.promptAndWait(session?.id, rubric, { pollMs: POLL_MS, timeoutMs: 10 * 60 * 1000 })
      }
  }
}

/** Create a job record (shared by inbox scans and the web API). */
function newJob (fields) {
  const now = new Date().toISOString()
  return normalizeJob({
    id: uniqId(),
    status: 'queued',
    queuedAt: now,
    startedAt: '',
    finishedAt: '',
    attempts: 0,
    evaluations: [],
    stageStatus: {},
    stageCursor: 0,
    ...fields
  })
}

function queueJob (job) {
  job.status = 'queued'
  job.pauseReq = false
  job.cancelReq = false
  if (!queue.includes(job.id)) queue.push(job.id)
  saveState()
  publishEvent('build.queued', `"${job.name}" queued (division ${job.division || 'core'})`, { jobId: job.id, jobName: job.name, division: job.division })
}

// ---- inbox scanning ---------------------------------------------------------
function scanWorkspace (ws) {
  const inbox = path.join(workspacePath(ws), 'inbox')
  fs.mkdirSync(inbox, { recursive: true })
  for (const entry of fs.readdirSync(inbox, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = path.join(inbox, entry.name)
    const manifestFile = path.join(folder, 'manifest.json')
    if (!fs.existsSync(manifestFile)) continue

    let manifest = {}
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch (e) { log.warn(`${entry.name}: invalid manifest.json → skipped`) }

    const division = manifest.division || ws.division || 'core'
    const appsDir = path.join(ROOT, 'apps', slugId(division) || 'core')
    fs.mkdirSync(appsDir, { recursive: true })
    const name = manifest.name || entry.name
    let target = path.join(appsDir, name)
    let n = 2
    while (fs.existsSync(target)) { target = path.join(appsDir, `${name}-${n++}`) }

    try { fs.renameSync(folder, target) } catch (e) {
      log.error(`${entry.name}: could not move into apps/: ${e.message}`)
      continue
    }

    const model = manifest.model || workspaceModelRef(ws) || settings.model
    const agent = manifest.agent || roleById(settings, ws.role)?.agent || ws.role || 'builder'
    const job = newJob({
      workspaceID: ws.id, workspaceName: ws.name, name,
      dir: target, model, agent, division,
      stages: Array.isArray(manifest.stages) ? manifest.stages : undefined,
      description: manifest.description || '',
      clientsNote: manifest.prompt || manifest.description || name,
      prompt: manifest.prompt || ''
    })
    jobs.push(job)
    queue.push(job.id)
    log.info(`[${ws.id}] queued "${name}" (${division}) -> ${path.relative(ROOT, target)}`)
  }
  saveState()
}

// ---- pipeline ---------------------------------------------------------------
async function runJob (job) {
  job.status = 'running'
  job.startedAt = job.startedAt || new Date().toISOString()
  job.error = ''
  saveState()
  log.info(`[${job.id}] starting "${job.name}" (division ${job.division || 'core'})`)
  try {
    await runPipeline(job, pipelineCtx())
  } catch (e) {
    job.error = e.message
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    saveState()
    publishEvent('build.failed', `"${job.name}" FAILED — ${e.message.slice(0, 140)}`, { jobId: job.id, jobName: job.name })
    log.error(`[${job.id}] "${job.name}" crashed in pipeline: ${e.message}`)
  }
  if (job.status === 'done') finalizeDeploy(job)
}

function finalizeDeploy (job) {
  if (job.preview && previews.some(p => p.id === job.id)) return
  const p = startPreview(job)
  if (p) {
    job.preview = p
    saveState()
  }
}

// ---- local preview servers (port pool 8100+, avoiding 8099 + the session port)
function startPreview (job) {
  if (!job.dir || !fs.existsSync(job.dir)) return null
  const base = settings.previewBase || 8100
  const used = new Set(previews.map(p => p.port).concat([settings.healthPort || 8099, settings.port]))
  let port = base
  while (used.has(port)) port++
  const dir = job.dir
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.md': 'text/markdown', '.txt': 'text/plain',
    '.map': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
  }
  const server = http.createServer((req, res) => {
    let url
    try { url = decodeURIComponent((req.url || '/').split('?')[0]) } catch { url = '/' }
    if (url === '/') url = '/index.html'
    const file = path.normalize(path.join(dir, url))
    if (file !== dir && !file.startsWith(dir + path.sep)) { res.statusCode = 403; res.end('forbidden'); return }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return }
      res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store')
      res.end(data)
    })
  })
  server.on('error', e => log.error(`preview ${job.name} port ${port} failed: ${e.message}`))
  server.listen(port, '127.0.0.1', () => log.ok(`preview for "${job.name}" → http://127.0.0.1:${port}/`))
  const entry = { id: job.id, name: job.name, dir: job.dir, port, url: `http://127.0.0.1:${port}/`, startedAt: new Date().toISOString() }
  previews.push(entry)
  savePreviews()
  return entry
}

// CEO assistant (non-pipeline employee) — when the CEO asks for reports, comms,
// or to notify workers via bridges, we route the work to the CEO Assistant worker.
function getCeoAssistant () {
  return (settings.workers || []).find(w => w.role === CEO_ROLE && w.status !== 'paused') || null
}

function ceoAssistantModelRef () {
  const w = getCeoAssistant()
  if (!w) return settings.model
  const m = w.model || settings.model
  const v = w.variant && w.variant !== 'default' ? `#${w.variant}` : ''
  return m + v
}

function ceoAssistantAgent () {
  const w = getCeoAssistant()
  const role = w ? roleById(settings, w.role) : null
  return role?.agent || CEO_ROLE || 'ceo-assistant'
}

// ---- bridge helpers ----------------------------------------------------------
const bridgeNotifiers = []
export function onBridgeNotification (fn) { bridgeNotifiers.push(fn); return () => bridgeNotifiers.splice(bridgeNotifiers.indexOf(fn), 1) }

// ---- human actions (panel + API) -------------------------------------------
function jobAction (job, action) {
  const now = new Date().toISOString()
  switch (action) {
    case 'pause':
      if (job.status === 'queued') {
        queue = queue.filter(id => id !== job.id)
        job.status = 'paused'
        job.pauseReq = true
      } else if (job.status === 'running') {
        job.pauseReq = true
      } else if (job.status === 'needs-review' || job.status === 'done') {
        job.pauseReq = true
        job.status = 'paused'
      }
      break
    case 'resume':
      job.pauseReq = false
      job.cancelReq = false
      queueJob(job)
      break
    case 'cancel':
      job.cancelReq = true
      job.pauseReq = false
      queue = queue.filter(id => id !== job.id)
      job.status = 'cancelled'
      job.finishedAt = now
      publishEvent('build.cancelled', `"${job.name}" was cancelled by the CEO`, { jobId: job.id, jobName: job.name })
      break
    case 'approve': // human says the paused stage's output is acceptable
      if (job.status === 'needs-review') {
        const st = job.waitingStage
        job.evaluations.push({ action: 'approved', stage: st, approvedAt: now })
        if (job.stageStatus) job.stageStatus[st] = 'done'
        job.stageCursor = (job.stageCursor || 0) + 1
        job.lastCritique = ''
        job.finishedAt = ''
        queueJob(job)
      }
      break
    case 'reject':
      if (job.status === 'needs-review') {
        job.status = 'failed'
        job.error = `rejected by operator at ${job.waitingStage}`
        job.finishedAt = now
        publishEvent('build.failed', `"${job.name}" was rejected by the CEO at ${job.waitingStage}`, { jobId: job.id, jobName: job.name, stage: job.waitingStage })
      }
      break
    case 'retry': // re-run the paused/failed stage with a fresh attempt
      if (job.status === 'needs-review' || job.status === 'failed' || job.status === 'paused') {
        if (job.status === 'failed') job.error = ''
        job.pauseReq = false
        job.cancelReq = false
        job.finishedAt = ''
        job.lastCritique = ''
        job.stageCursor = Math.max(0, (job.stageCursor || 0) - 1)
        queueJob(job)
      }
      break
    default:
      return false
  }
  saveState()
  return true
}

// ---- settings reload (CRUD writes are picked up live) ----------------------
function reloadSettings () {
  const next = ensureAllWorkspaces(loadSettings(true))
  Object.assign(settings, next)
  return settings
}

/** Mutate the authoritative model, persist, then reload from disk. */
function commitModel () {
  saveSettings(settings)
  reloadSettings()
  return settings
}

// ---- worker / role / division CRUD helpers ---------------------------------
function addWorker (fields) {
  const errs = validateWorker(fields, settings)
  if (errs.length) return { error: errs.join('; ') }
  const w = {
    id: slugId(String(fields.name)) || 'worker',
    name: String(fields.name).trim(),
    role: fields.role,
    division: fields.division || settings.divisions[0]?.id || 'core',
    model: fields.model,
    variant: fields.variant || 'medium',
    description: fields.description || '',
    status: fields.status === 'paused' ? 'paused' : 'active'
  }
  let id = w.id
  if (settings.workers.some(x => x.id === id)) {
    let n = 2
    while (settings.workers.some(x => x.id === id)) id = `${w.id}-${n++}`
    w.id = id
  }
  settings.workers.push(w)
  commitModel()
  return { worker: w }
}

function updateWorker (id, fields) {
  const w = settings.workers.find(x => x.id === id)
  if (!w) return { error: 'worker not found' }
  if (fields.name !== undefined) {
    const name = String(fields.name).trim()
    if (!name) return { error: 'name is required' }
    w.name = name
  }
  if (fields.role !== undefined) {
    if (!roleById(settings, fields.role)) return { error: `unknown role "${fields.role}"` }
    w.role = fields.role
  }
  if (fields.division !== undefined) w.division = fields.division
  if (fields.model !== undefined) w.model = fields.model
  if (fields.variant !== undefined) w.variant = fields.variant
  if (fields.description !== undefined) w.description = fields.description
  if (fields.status !== undefined) w.status = fields.status === 'paused' ? 'paused' : 'active'
  commitModel()
  return { worker: w }
}

function addRole (fields) {
  const name = String(fields.name || '').trim()
  if (!name) return { error: 'role name is required' }
  const id = slugId(fields.id || name) || slugId(name)
  if (settings.roles.some(r => r.id === id)) return { error: `role "${id}" already exists` }
  const stages = Array.isArray(fields.stages)
    ? fields.stages.filter(s => STAGES.includes(s)).filter((s, i, a) => a.indexOf(s) === i)
    : []
  settings.roles.push({
    id, name,
    stages,
    agent: String(fields.agent || '').trim() || 'general',
    description: String(fields.description || ''),
    scoreStages: fields.scoreStages === true ? true : undefined
  })
  commitModel()
  return { role: settings.roles[settings.roles.length - 1] }
}

function updateRole (id, fields) {
  const r = settings.roles.find(x => x.id === id)
  if (!r) return { error: 'role not found' }
  if (fields.name !== undefined) {
    const name = String(fields.name).trim()
    if (!name) return { error: 'role name is required' }
    r.name = name
  }
  if (fields.stages !== undefined) r.stages = Array.isArray(fields.stages) ? fields.stages.filter(s => STAGES.includes(s)) : []
  if (fields.agent !== undefined) r.agent = String(fields.agent || '').trim() || 'general'
  if (fields.description !== undefined) r.description = String(fields.description || '')
  if (fields.scoreStages !== undefined) r.scoreStages = fields.scoreStages === true ? true : undefined
  commitModel()
  return { role: r }
}

function addDivision (fields) {
  const name = String(fields.name || '').trim()
  if (!name) return { error: 'division name is required' }
  const id = slugId(fields.id || name) || slugId(name)
  if (settings.divisions.some(d => d.id === id)) return { error: `division "${id}" already exists` }
  settings.divisions.push({
    id, name,
    description: String(fields.description || ''),
    color: String(fields.color || DIV_COLORS[settings.divisions.length % DIV_COLORS.length])
  })
  commitModel()
  return { division: settings.divisions[settings.divisions.length - 1] }
}

function updateDivision (id, fields) {
  const d = settings.divisions.find(x => x.id === id)
  if (!d) return { error: 'division not found' }
  if (fields.name !== undefined) {
    const name = String(fields.name).trim()
    if (!name) return { error: 'division name is required' }
    d.name = name
  }
  if (fields.description !== undefined) d.description = String(fields.description || '')
  if (fields.color !== undefined) d.color = String(fields.color || '#7dd3fc')
  commitModel()
  return { division: d }
}

function validSettingsFields (body) {
  const out = {}
  const num = (k, min, max) => {
    const n = parseInt(body[k], 10)
    if (Number.isInteger(n) && n >= min && n <= max) out[k] = n
  }
  num('evalThreshold', 0, 100)
  num('evalRetries', 0, 10)
  num('previewBase', 1024, 65535)
  num('parallel', 1, 16)
  return out
}

// ---- CEO assistant (reports · communications · notifications) ----------------
/** A plain-language snapshot of the office the assistant can report on. */
function officeSnapshot () {
  const byStatus = {}
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1
  const workerLine = (w) => `- ${w.name} (${w.role}) · ${w.division || 'core'} · ${w.model || '?'}${w.variant && w.variant !== 'default' ? '#' + w.variant : ''} · ${w.status || 'active'}`
  const jobLine = (j) => `- ${j.name} [${j.status}] · division ${j.division || 'core'}${j.stage ? ` · stage ${j.stage}` : ''}${j.finishedAt ? ` · ${String(j.finishedAt).slice(0, 19).replace('T', ' ')}` : ''}`
  return [
    '## Office',
    `- workers: ${settings.workers.length} (active ${settings.workers.filter(w => w.status !== 'paused').length})`,
    `- divisions: ${settings.divisions.map(d => d.id).join(', ')}`,
    `- jobs: ${jobs.length} total · ` + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · '),
    `- parallel capacity: ${WORKERS}`,
    '',
    '## Roster',
    ...settings.workers.map(workerLine),
    '',
    '## Recent jobs',
    ...(jobs.length ? [...jobs].reverse().slice(0, 12).map(jobLine) : ['- (none yet)'])
  ].join('\n')
}

/** Write the CEO assistant's reply to a file (reports, summaries) and index it. */
function saveCeoReport (title, body) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(CEO_DIR, `${stamp}-${slugId(title) || 'report'}.md`)
  fs.mkdirSync(CEO_DIR, { recursive: true })
  fs.writeFileSync(file, `# ${title}\n\n_Generated ${new Date().toISOString()} by the CEO Assistant_\n\n${body}\n`)
  ceo.reports.unshift({ id: uniqId(), title, file, at: new Date().toISOString() })
  ceo.reports = ceo.reports.slice(0, 40)
  saveCeo()
  return file
}

/**
 * Run the CEO assistant: build a prompt from live office state + the request,
 * let the assistant answer, persist the answer as a report.
 */
async function runCeoAssistant (task, request, extra = {}) {
  const assistant = getCeoAssistant()
  const dir = assistant ? workspacePath(assistant) : CEO_DIR
  fs.mkdirSync(dir, { recursive: true })
  const prompt = [
    'You are the CEO Assistant of Big Pickle (the company office of AI digital workers).',
    'The user you are speaking to is the CEO — the principal of this office.',
    '',
    'Office data:',
    officeSnapshot(),
    '',
    `Task: ${task}`,
    request ? `CEO request: ${request}` : '',
    '',
    'Answer for the CEO: concise, executive, decision-ready. Use short sections and bullet points.'
  ].filter(Boolean).join('\n')
  const title = `[ceo] ${extra.kind || 'report'}`
  const session = await client.createSession({
    title,
    directory: dir,
    agent: ceoAssistantAgent(),
    model: ceoAssistantModelRef()
  })
  const reply = await client.promptAndWait(session.id, prompt, { pollMs: POLL_MS, timeoutMs: 15 * 60 * 1000 })
  return { reply, assistant: assistant || null, dir }
}

/**
 * Report composed from office state alone — used in dry-run mode and whenever
 * the assistant model is unreachable, so the CEO always gets a document.
 */
function localCeoReport (task) {
  const byStatus = {}
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1
  const waiting = jobs.filter(j => j.status === 'needs-review')
  const failed = jobs.filter(j => j.status === 'failed')
  const done = jobs.filter(j => j.status === 'done')
  return [
    `# Office report — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '> Assembled locally from live office data (no model call).',
    '',
    '## Headline',
    `- ${settings.workers.length} staff across ${settings.divisions.length} division(s); ${done.length} app(s) shipped, ${waiting.length} awaiting your decision, ${failed.length} failed.`,
    '- Workload: ' + (Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || 'idle'),
    '',
    '## Needs your decision',
    ...(waiting.length ? waiting.map(j => `- **${j.name}** — stuck at ${j.waitingStage || '?'} (${j.division || 'core'})`) : ['- Nothing is blocked.']),
    '',
    '## Failures',
    ...(failed.length ? failed.slice(-6).map(j => `- **${j.name}** — ${(j.error || 'unknown').slice(0, 140)}`) : ['- None.']),
    '',
    '## Shipped',
    ...(done.length ? done.slice(-6).reverse().map(j => `- ${j.name}${j.preview?.url ? ` — ${j.preview.url}` : ''}`) : ['- Nothing shipped yet.']),
    '',
    '## Staff',
    ...settings.workers.map(w => `- ${w.name} — ${w.role} (${w.division || 'core'})${w.status === 'paused' ? ' · paused' : ''}`),
    '',
    '## Task',
    task || 'general office report',
    ''
  ].join('\n')
}

// ---- dispatch loop ----------------------------------------------------------
async function dispatchLoop () {
  ensureDirs()
  loadState()
  loadPreviews()
  loadEvents()
  loadCeo()

  // Recover stale running/paused entries from a previous crash.
  for (const j of jobs) {
    if (j.status === 'running' || (j.status === 'paused' && !j.pauseReq)) {
      j.status = 'queued'
      queue.push(j.id)
    }
  }
  saveState()

  const tick = () => {
    for (const ws of settings.workers) scanWorkspace(ws)
    while (queue.length && activeWorkers() < WORKERS) {
      const id = queue.shift()
      const job = jobById(id)
      if (job && job.status === 'queued' && !job.cancelReq) spawnWorker(job)
    }
  }
  setInterval(tick, POLL_MS)
  tick()
  log.ok(`orchestrator active — ${settings.workers.length} workers · ${WORKERS} parallel builds · pipeline Plan→Build→Review→Test→Deploy`)
  startHttp()
}

let running = 0
function activeWorkers () { return running }
function spawnWorker (job) {
  running++
  runJob(job).finally(() => running--)
}

// ---- status + API HTTP server ----------------------------------------------
function officeKey (req) {
  return (req.headers['x-office-key'] || '').toString()
}
function authorized (req) {
  return officeKey(req) === (process.env.BIGPICKLE_TOKEN || readPassword())
}
function readBody (req) {
  return new Promise(resolve => {
    let d = ''
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}
function send (res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

function startHttp () {
  const port = settings.healthPort || 8099

  http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0]
    const method = req.method || 'GET'
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-office-key')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

    // office cam (Phase 4: becomes the Roof tab inside the panel)
    if (url === '/' || url === '/office') {
      let html = ''
      try { html = fs.readFileSync(path.join(ROOT, 'public', 'office.html'), 'utf8') } catch {}
      if (!html) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('office dashboard missing (public/office.html)'); return }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(html)
      return
    }

    // legacy status endpoints (cam + status script)
    if (url === '/health') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, name: 'bigpickle-orchestrator', workers: WORKERS, active: activeWorkers(), queued: queue.length, workersOf: settings.workers.length, jobs: jobs.length }))
      return
    }
    if (url === '/jobs') { send(res, 200, { jobs }); return }
    if (url === '/workspaces') { send(res, 200, { theme: settings.theme, workspaces: settings.workspaces }); return }

    // API
    if (url === '/api/builds' && method === 'GET') { send(res, 200, { builds: jobs }); return }

    if (url === '/api/builds' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const name = slugId(String(body.name || '')) || slugId(String(body.description || '')) || 'app'
      const div = divisionById(settings, body.division) ? body.division : (settings.divisions[0]?.id || 'core')
      const appsDir = path.join(ROOT, 'apps', slugId(div) || 'core')
      fs.mkdirSync(appsDir, { recursive: true })
      let target = path.join(appsDir, name)
      let n = 2
      while (fs.existsSync(target)) { target = path.join(appsDir, `${name}-${n++}`) }
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
        name, description: String(body.description || ''), stack: body.stack || '',
        division: div, stages: Array.isArray(body.stages) ? body.stages : undefined,
        model: body.model || '', prompt: body.prompt || ''
      }, null, 2) + '\n')

      const job = newJob({
        name,
        dir: target,
        division: div,
        model: body.model || settings.model,
        agent: 'pipeline',
        stages: Array.isArray(body.stages) ? body.stages : undefined,
        description: String(body.description || '').slice(0, 2000),
        clientsNote: String(body.prompt || body.description || name).slice(0, 3000),
        prompt: body.prompt || '',
        source: 'panel'
      })
      jobs.push(job)
      queue.push(job.id)
      saveState()
      log.ok(`[api] built "${name}" queued (division ${div})`)
      return send(res, 201, { job })
    }

    const actionMatch = url.match(/^\/api\/builds\/([^/]+)\/action$/)
    if (actionMatch && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const job = jobById(actionMatch[1])
      if (!job) return send(res, 404, { error: 'build not found' })
      const body = await readBody(req)
      const ok = jobAction(job, String(body.action || ''))
      if (!ok) return send(res, 400, { error: `unknown action "${body.action}"` })
      log.info(`[${job.id}] action ${body.action} → ${job.status}`)
      return send(res, 200, { job })
    }

    if (url === '/api/previews' && method === 'GET') { send(res, 200, { previews }); return }

    const stopMatch = url.match(/^\/api\/previews\/([^/]+)\/stop$/)
    if (stopMatch && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const before = previews.length
      previews = previews.filter(p => p.id !== stopMatch[1])
      if (previews.length === before) return send(res, 404, { error: 'preview not found' })
      savePreviews()
      send(res, 200, { ok: true, previews })
      return
    }

    // control panel (Phase 3)
    if (url === '/panel') {
      let html = ''
      try { html = fs.readFileSync(path.join(ROOT, 'public', 'panel.html'), 'utf8') } catch {}
      if (!html) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('panel missing (public/panel.html)'); return }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(html)
      return
    }

    // single build
    const buildMatch = url.match(/^\/api\/builds\/([^/]+)$/)
    if (buildMatch && method === 'GET') {
      const job = jobById(buildMatch[1])
      if (!job) return send(res, 404, { error: 'build not found' })
      return send(res, 200, { job })
    }

    // evaluations (flattened across builds, newest first)
    if (url === '/api/evaluations' && method === 'GET') {
      const evals = jobs.flatMap(j =>
        (j.evaluations || []).map(e => ({
          ...e,
          jobId: j.id, jobName: j.name, jobStatus: j.status, jobDivision: j.division,
          waitingStage: j.waitingStage, preview: j.preview
        }))
      ).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      return send(res, 200, { evaluations: evals.slice(0, 300) })
    }

    // ── events (the CEO notification feed; bridges poll this) ───────────────
    if (url === '/api/events' && method === 'GET') {
      const since = parseInt(new URL(req.url, 'http://x').searchParams.get('since') || '0', 10) || 0
      const list = since
        ? events.filter(e => new Date(e.at).getTime() > since)
        : events.slice(-60)
      return send(res, 200, { events: list, count: list.length })
    }

    // ── CEO assistant ──────────────────────────────────────────────────────
    if (url === '/api/ceo' && method === 'GET') {
      const a = getCeoAssistant()
      return send(res, 200, {
        assistant: a,
        agent: ceoAssistantAgent(),
        model: ceoAssistantModelRef(),
        notices: ceo.notices || [],
        reports: ceo.reports || [],
        bridges: {
          discord: !!(settings.integrations?.discord?.enabled && (settings.integrations?.discord?.notifyChannelId || process.env.DISCORD_NOTIFY_CHANNEL_ID)),
          whatsapp: !!(settings.integrations?.whatsapp?.enabled && (settings.integrations?.whatsapp?.ceoJid || process.env.WHATSAPP_CEO_JID))
        }
      })
    }

    // CEO → office: a report, summary or briefing from the CEO Assistant.
    if (url === '/api/ceo/report' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const question = String(body.question || body.prompt || '').trim()
      const kind = String(body.kind || 'report')
      const task = kind === 'summary'
        ? 'Write a short executive summary of the office right now (status, notable jobs, anything needing the CEO).'
        : question || 'Write the CEO report for the office: current state of every build, evaluations, and what needs the CEO decision.'
      try {
        const { reply, assistant } = DRY
          ? { reply: localCeoReport(task), assistant: getCeoAssistant() }
          : await runCeoAssistant(task, question, { kind })
        const file = saveCeoReport(`${kind} · ${new Date().toISOString().slice(0, 10)}`, reply)
        publishEvent('ceo.report', `CEO report ready (${assistant?.name || 'assistant'})`, { file })
        return send(res, 200, { ok: true, report: reply, file })
      } catch (e) {
        log.error('ceo report failed: ' + e.message + ' — falling back to a local report')
        const report = localCeoReport(task)
        const file = saveCeoReport(`${kind} · ${new Date().toISOString().slice(0, 10)}`, report)
        return send(res, 200, { ok: true, report, file, offline: true })
      }
    }

    // CEO → workers: a broadcast notice, delivered to every worker's folder.
    if (url === '/api/ceo/notice' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const text = String(body.text || body.message || '').trim()
      if (!text) return send(res, 400, { error: 'notice text is required' })
      const audience = String(body.audience || 'all')
      const targets = settings.workers.filter(w =>
        audience === 'all' || (audience === 'division' ? w.division === body.division : w.id === body.worker)
      )
      const notice = {
        id: uniqId(),
        at: new Date().toISOString(),
        from: 'CEO',
        text,
        audience,
        division: body.division || '',
        worker: body.worker || '',
        deliveredTo: targets.map(w => w.id)
      }
      for (const w of targets) {
        const dir = workspacePath(w)
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'NOTICE.md'), `\n## [${notice.at}] From the CEO\n\n${text}\n`)
      }
      ceo.notices.unshift(notice)
      ceo.notices = ceo.notices.slice(0, 100)
      saveCeo()
      publishEvent('ceo.notice', `CEO notice → ${targets.length} worker(s): ${text.slice(0, 120)}`, { noticeId: notice.id })
      log.ok(`CEO notice delivered to ${targets.length} worker(s)`)
      return send(res, 200, { ok: true, notice })
    }

    // settings (eval config etc.)
    if (url === '/api/settings' && method === 'GET') {
      return send(res, 200, {
        theme: settings.theme, port: settings.port, healthPort: settings.healthPort,
        parallel: WORKERS, evalThreshold: settings.evalThreshold ?? 70,
        evalRetries: settings.evalRetries ?? 2, previewBase: settings.previewBase ?? 8100,
        dry: DRY, pollMs: POLL_MS
      })
    }
    if (url === '/api/settings' && (method === 'PUT' || method === 'POST')) {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const patch = validSettingsFields(body)
      if (Object.keys(patch).length === 0) return send(res, 400, { error: 'no valid settings fields (evalThreshold, evalRetries, previewBase, parallel)' })
      settings.evalThreshold = patch.evalThreshold ?? settings.evalThreshold
      settings.evalRetries = patch.evalRetries ?? settings.evalRetries
      settings.previewBase = patch.previewBase ?? settings.previewBase
      settings.parallel = patch.parallel ?? settings.parallel
      WORKERS = settings.parallel
      saveSettings(settings)
      reloadSettings()
      log.info(`settings updated: ${JSON.stringify(patch)}`)
      return send(res, 200, { ok: true, settings: { evalThreshold: settings.evalThreshold, evalRetries: settings.evalRetries, previewBase: settings.previewBase, parallel: WORKERS } })
    }

    // models catalog (for the new-build / worker forms + the Models tab)
    if (url === '/api/models' && method === 'GET') {
      const rows = loadAllModels()
      return send(res, 200, {
        models: allModelRefs(),
        catalog: rows,
        free: rows.filter(r => r.free && !r.retired).map(r => r.ref),
        summary: modelSummary(),
        gateways: gatewayState()
      })
    }

    // gateway base URL / API keys (9router + OpenCode Zen)
    if (url === '/api/gateways' && method === 'GET') {
      return send(res, 200, { gateways: gatewayState() })
    }
    if (url === '/api/gateways' && (method === 'PUT' || method === 'POST')) {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const results = []
      for (const provider of ['9router', 'opencode']) {
        if (!body[provider]) continue
        const r = saveGateway(provider, body[provider])
        if (r.error) return send(res, 400, { error: r.error })
        results.push(provider)
      }
      if (!results.length) return send(res, 400, { error: 'nothing to save — send {"9router":{...}} or {"opencode":{...}}' })
      reloadSettings()
      for (const p of results) log.ok(`gateway saved: ${p}`)
      return send(res, 200, { ok: true, gateways: gatewayState() })
    }

    // live model-list sync from a gateway
    if (url === '/api/models/sync' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const provider = String(body.provider || 'opencode')
      const r = await syncModels(provider)
      if (r.error) return send(res, 400, { error: r.error })
      log.ok(`models synced: ${r.provider} → ${r.count} models (${r.free} free)`)
      publishEvent('models.synced', `${provider} catalog synced: ${r.count} models, ${r.free} free`, { provider })
      return send(res, 200, { ...r, catalog: loadAllModels(), summary: modelSummary() })
    }

    // CEO-added model refs (any provider, any gateway)
    if (url === '/api/models/custom' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const ref = String(body.ref || '').trim()
      if (!ref || ref.split('/').filter(Boolean).length < 2) {
        return send(res, 400, { error: 'model ref must look like provider/model-id' })
      }
      addCustomModel(ref, body.name ? String(body.name).slice(0, 80) : '')
      log.ok(`custom model added: ${ref}`)
      return send(res, 201, { ok: true, custom: loadCustomModels(), catalog: loadAllModels() })
    }
    if (url === '/api/models/custom' && method === 'DELETE') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const ref = String(body.ref || '')
      removeCustomModel(ref)
      log.ok(`custom model removed: ${ref}`)
      return send(res, 200, { ok: true, custom: loadCustomModels(), catalog: loadAllModels() })
    }

    // tool pages: 9router / Zen / OpenCode docs + the office's own endpoints
    if (url === '/api/tools' && method === 'GET') {
      return send(res, 200, { tools: TOOL_PAGES, office: OFFICE_PAGES })
    }

    // workers CRUD
    if (url === '/api/workers' && method === 'GET') {
      return send(res, 200, {
        divisions: settings.divisions, roles: settings.roles,
        workers: settings.workers, usedParallel: running
      })
    }
    if (url === '/api/workers' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = addWorker(body)
      if (r.error) return send(res, 400, { error: r.error })
      log.info(`worker added: ${r.worker.id} (${r.worker.role})`)
      return send(res, 201, r)
    }
    const workerMatch = url.match(/^\/api\/workers\/([^/]+)$/)
    if (workerMatch && method === 'GET') {
      const w = settings.workers.find(x => x.id === workerMatch[1])
      if (!w) return send(res, 404, { error: 'worker not found' })
      return send(res, 200, { worker: w })
    }
    if (workerMatch && method === 'PUT') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = updateWorker(workerMatch[1], body)
      if (r.error) return send(res, 400, { error: r.error })
      log.info(`worker updated: ${r.worker.id}`)
      return send(res, 200, r)
    }
    if (workerMatch && method === 'DELETE') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const before = settings.workers.length
      settings.workers = settings.workers.filter(w => w.id !== workerMatch[1])
      if (settings.workers.length === before) return send(res, 404, { error: 'worker not found' })
      commitModel()
      log.info(`worker deleted: ${workerMatch[1]}`)
      return send(res, 200, { ok: true })
    }
    const workerActMatch = url.match(/^\/api\/workers\/([^/]+)\/action$/)
    if (workerActMatch && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const w = settings.workers.find(x => x.id === workerActMatch[1])
      if (!w) return send(res, 404, { error: 'worker not found' })
      const body = await readBody(req)
      if (body.action === 'pause') w.status = 'paused'
      else if (body.action === 'resume') w.status = 'active'
      else return send(res, 400, { error: 'action must be pause or resume' })
      commitModel()
      return send(res, 200, { worker: w })
    }

    // roles CRUD
    if (url === '/api/roles' && method === 'GET') { return send(res, 200, { roles: settings.roles, stages: STAGES, stageLabels: STAGE_LABELS }) }
    if (url === '/api/roles' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = addRole(body)
      if (r.error) return send(res, 400, { error: r.error })
      log.info(`role added: ${r.role.id}`)
      return send(res, 201, r)
    }
    const roleMatch = url.match(/^\/api\/roles\/([^/]+)$/)
    if (roleMatch && method === 'PUT') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = updateRole(roleMatch[1], body)
      if (r.error) return send(res, 400, { error: r.error })
      return send(res, 200, r)
    }
    if (roleMatch && method === 'DELETE') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const before = settings.roles.length
      settings.roles = settings.roles.filter(r => r.id !== roleMatch[1])
      if (settings.roles.length === before) return send(res, 404, { error: 'role not found' })
      commitModel()
      return send(res, 200, { ok: true })
    }

    // divisions CRUD
    if (url === '/api/divisions' && method === 'GET') { return send(res, 200, { divisions: settings.divisions }) }
    if (url === '/api/divisions' && method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = addDivision(body)
      if (r.error) return send(res, 400, { error: r.error })
      return send(res, 201, r)
    }
    const divMatch = url.match(/^\/api\/divisions\/([^/]+)$/)
    if (divMatch && method === 'PUT') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const body = await readBody(req)
      const r = updateDivision(divMatch[1], body)
      if (r.error) return send(res, 400, { error: r.error })
      return send(res, 200, r)
    }
    if (divMatch && method === 'DELETE') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-office-key header' })
      const before = settings.divisions.length
      settings.divisions = settings.divisions.filter(d => d.id !== divMatch[1])
      if (settings.divisions.length === before) return send(res, 404, { error: 'division not found' })
      commitModel()
      return send(res, 200, { ok: true })
    }

    send(res, 404, { error: 'not found', routes: ['/ (office cam)', '/panel', '/health', '/jobs', '/workspaces', '/api/builds', '/api/builds/:id/action', '/api/workers', '/api/roles', '/api/divisions', '/api/settings', '/api/evaluations', '/api/models', '/api/previews'] })
  }).listen(port, '127.0.0.1', () => log.info(`status+api http://127.0.0.1:${port} (cam: / · api: /api/builds · ${DRY ? 'DRY RUN' : ''})`))
}

dispatchLoop().catch(e => { log.error('orchestrator crashed: ' + (e.stack || e.message)); process.exit(1) })