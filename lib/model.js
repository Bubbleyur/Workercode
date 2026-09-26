// model.js — Digital Workers data model (settings.json v2).
//
// A Digital Worker is an AI employee:
//   { id, name, role, division, model, variant, description, status }
//   - role      → its job in the office (which SDLC stages it performs)
//   - division  → the team it belongs to (divisions OWN the builds)
//   - model     → "provider/model" (+ variant) it runs on
//   - status    → "active" | "paused"
//
// Roles are the heart of the pipeline: each role declares STAGES it can do
// (plan / build / review / test / deploy) and the OpenCode agent it maps to.
// The SDLC for an app uses whatever active workers exist — unknown roles and
// missing workers degrade gracefully via STAGE_FALLBACK.

export const THEME = 'company office'
export const STAGES = ['plan', 'build', 'review', 'test', 'deploy']
export const STAGE_LABELS = { plan: 'Plan', build: 'Build', review: 'Review', test: 'Test', deploy: 'Deploy' }

// When a stage's owning role has no active worker, the orchestrator tries
// these roles in order (still division-first). If none exists the stage is
// skipped and recorded.
export const STAGE_FALLBACK = {
  plan: ['builder', 'reviewer'],
  build: ['reviewer'],
  review: ['builder'],
  test: ['reviewer', 'builder'],
  deploy: ['builder']
}

export const DIV_COLORS = ['#7dd3fc', '#fbbf24', '#34d399', '#c084fc', '#f472b6', '#f87171', '#4ade80', '#60a5fa']
export const SUGGESTED_WORKERS = ['Strategy', 'Engineering', 'Quality', 'Testing', 'Delivery', 'Insights', 'Support', 'CEO Assistant']

// The CEO-assistant role id — the CEO's right hand (reports, communications,
// notifications). It owns no SDLC stage; the pipeline never picks it, but it
// exists as an employee the CEO can task from the control panel.
export const CEO_ROLE = 'ceo-assistant'

/** The built-in role catalog. Users may add fully custom roles (web panel). */
export function defaultRoles () {
  return [
    { id: 'architect', name: 'Architect', stages: ['plan'], agent: 'architect', description: 'Planning, architecture and product decisions' },
    { id: 'builder', name: 'Builder', stages: ['build'], agent: 'builder', description: 'Writing and shipping app code' },
    { id: 'reviewer', name: 'Reviewer', stages: ['review'], agent: 'reviewer', scoreStages: ['plan', 'build', 'review', 'test', 'deploy'], description: 'Code review and evaluation scoring' },
    { id: 'tester', name: 'Tester', stages: ['test'], agent: 'tester', description: 'Automated + manual validation, test writing' },
    { id: 'deployer', name: 'Deployer', stages: ['deploy'], agent: 'deployer', description: 'Build, packaging and local preview' },
    { id: 'data-scientist', name: 'Data Scientist', stages: [], agent: 'data-scientist', description: 'Data analysis and research' },
    { id: 'support', name: 'Support', stages: [], agent: 'support', description: 'Docs, triage and chat through the bridges' },
    { id: 'ceo-assistant', name: 'CEO Assistant', stages: [], agent: 'ceo-assistant', description: "The CEO's right hand — executive reports, CEO↔worker communications, notifications" }
  ]
}

export function defaultDivisions () {
  return [{ id: 'core', name: 'Core', description: 'The main office team', color: '#7dd3fc' }]
}

/** A sensible starting team: one active worker per SDLC role + the CEO assistant. */
export function defaultWorkers (roles = defaultRoles(), divisions = defaultDivisions()) {
  const div = divisions[0]?.id || 'core'
  const model = {
    architect: '9router/oc/union-alpha',
    builder: '9router/oc/muse-spark-1.3-contributor-free',
    reviewer: '9router/sekai/tencent/hy4-preview',
    tester: '9router/sekai/cx/gpt-6-astra',
    deployer: '9router/sekai/tencent/hy4-preview',
    [CEO_ROLE]: '9router/oc/union-alpha'
  }
  const hires = [
    ['strategy', 'Strategy', 'architect', 'Planning, architecture and product decisions'],
    ['engineering', 'Engineering', 'builder', 'Writing and shipping app code'],
    ['quality', 'Quality', 'reviewer', 'Code review and evaluation scoring'],
    ['testing', 'Testing', 'tester', 'Automated validation, QA and test writing'],
    ['delivery', 'Delivery', 'deployer', 'Build, packaging and local preview'],
    ['ceo-assistant', 'CEO Assistant', CEO_ROLE, "The CEO's right hand — reports, communications, notifications"]
  ]
  return hires.map(([id, name, role, description]) => ({
    id, name, role, division: div,
    model: (roles.some(r => r.id === role) ? model[role] : undefined) || model.builder,
    variant: 'medium', description, status: 'active'
  }))
}

/** "My Team Name" → "my-team-name"; safe for ids and folder names. */
export function slugId (name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function roleById (settings, id) {
  return (settings.roles || []).find(r => r.id === id)
}

export function divisionById (settings, id) {
  return (settings.divisions || []).find(d => d.id === id)
}

/** "provider/model#variant" stored on a worker. */
export function workerModelRef (w) {
  if (!w) return ''
  const m = w.model || ''
  const v = w.variant && w.variant !== 'default' ? `#${w.variant}` : ''
  return m + v
}

/** Keep the built-in roles present; append any that were removed or never added. */
export function ensureRoleCatalog (settings) {
  if (!Array.isArray(settings.roles)) settings.roles = []
  for (const def of defaultRoles()) {
    if (!settings.roles.some(r => r.id === def.id)) settings.roles.push(structuredClone(def))
  }
  return settings.roles
}

/** Mirror workers back into the legacy `workspaces` array so older code
 *  (bridges, status, new-app, the cam) keeps working unchanged. */
export function syncWorkspaces (settings) {
  settings.workspaces = (settings.workers || []).map(w => {
    const role = roleById(settings, w.role)
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      agent: role?.agent || w.role,
      division: w.division,
      model: w.model,
      variant: w.variant,
      description: w.description,
      status: w.status
    }
  })
  return settings
}

function legacyToWorker (ws, settings) {
  return {
    id: ws.id || slugId(ws.name) || 'worker',
    name: ws.name,
    role: ws.role || 'builder',
    division: settings.divisions[0]?.id || 'core',
    model: ws.model,
    variant: ws.variant || 'medium',
    description: ws.description || '',
    status: 'active'
  }
}

/** Upgrade any settings object to the Digital Workers model (idempotent). */
export function ensureModel (settings = {}) {
  settings.theme = settings.theme || THEME
  ensureRoleCatalog(settings)
  if (!Array.isArray(settings.divisions) || !settings.divisions.length) settings.divisions = defaultDivisions()
  // Legacy settings used `workers` for the parallel build count (a number).
  // It now names the roster (an array) — move the old number to `parallel`.
  if (typeof settings.workers === 'number') {
    if (settings.parallel === undefined) settings.parallel = settings.workers
    settings.workers = undefined
  }
  if (!Array.isArray(settings.workers) || !settings.workers.length) {
    if (Array.isArray(settings.workspaces) && settings.workspaces.length) {
      settings.workers = settings.workspaces.map(ws => legacyToWorker(ws, settings))
    } else {
      settings.workers = defaultWorkers(settings.roles, settings.divisions)
    }
  }
  // The SDLC pipeline wants a tester — make sure some worker covers it.
  const hasTesterRole = settings.roles.some(r => r.id === 'tester')
  const hasTesterWorker = settings.workers.some(w => w.role === 'tester')
  if (hasTesterRole && !hasTesterWorker) {
    const donor = settings.workers.find(w => w.role === 'reviewer') || settings.workers[0]
    settings.workers.push({
      id: slugId('testing') || 'testing',
      name: 'Testing',
      role: 'tester',
      division: settings.divisions[0]?.id || 'core',
      model: donor?.model || '9router/oc/muse-spark-1.3-contributor-free',
      variant: donor?.variant || 'medium',
      description: 'Automated validation, QA and test writing',
      status: 'active'
    })
  }
  // The CEO needs their assistant — auto-hire one whenever the role exists.
  if (settings.roles.some(r => r.id === CEO_ROLE) && !settings.workers.some(w => w.role === CEO_ROLE)) {
    const donor = settings.workers.find(w => w.role === 'architect') || settings.workers[0]
    settings.workers.push({
      id: slugId('ceo-assistant') || 'ceo-assistant',
      name: 'CEO Assistant',
      role: CEO_ROLE,
      division: settings.divisions[0]?.id || 'core',
      model: donor?.model || '9router/oc/union-alpha',
      variant: donor?.variant || 'medium',
      description: "The CEO's right hand — reports, communications, notifications",
      status: 'active'
    })
  }
  // normalise every worker + guarantee unique ids
  const used = new Set()
  for (const w of settings.workers) {
    if (!w.id) w.id = slugId(w.name)
    let id = w.id || 'worker'
    let n = 2
    while (used.has(id)) id = `${w.id || 'worker'}-${n++}`
    w.id = id
    used.add(id)
    w.status = w.status || 'active'
    w.division = w.division || settings.divisions[0]?.id || 'core'
    w.variant = w.variant || 'medium'
    if (!w.model) w.model = '9router/oc/muse-spark-1.3-contributor-free'
  }
  syncWorkspaces(settings)
  return settings
}

/** Pick an active worker for a pipeline stage, division-first, then fallback chain. */
export function activeWorkerForStage (settings, stage, divisionId) {
  const active = (settings.workers || []).filter(w => w.status !== 'paused')
  if (!active.length) return null
  const divExists = divisionId && (settings.divisions || []).some(d => d.id === divisionId)
  const pick = list => {
    if (!list.length) return null
    const inDiv = divExists ? list.find(w => w.division === divisionId) : null
    return inDiv || list[0]
  }
  const stageRoles = (settings.roles || []).filter(r => (r.stages || []).includes(stage)).map(r => r.id)
  const chain = [...stageRoles, ...(STAGE_FALLBACK[stage] || [])]
  for (const rid of chain) {
    const w = pick(active.filter(x => x.role === rid))
    if (w) return { worker: w, role: roleById(settings, rid) || { id: rid, agent: rid, stages: [stage] }, stage }
  }
  return null
}

/** Basic integrity checks used by the wizard and the CRUD API. */
export function validateWorker (w, settings) {
  const errs = []
  if (!w) return ['worker object required']
  if (!String(w.name || '').trim()) errs.push('name is required')
  if (!w.role) errs.push('role is required')
  else if (!roleById(settings, w.role)) errs.push(`unknown role "${w.role}"`)
  if (w.division && !(settings.divisions || []).some(d => d.id === w.division)) errs.push(`unknown division "${w.division}"`)
  const m = String(w.model || '')
  if (!m.includes('/')) errs.push('model must look like "provider/model" (optionally #variant)')
  if (w.status && !['active', 'paused'].includes(w.status)) errs.push('status must be "active" or "paused"')
  return errs
}