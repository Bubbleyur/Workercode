// workspaces.js — "company office" filesystem layer. The authoritative model
// now lives in model.js (divisions / roles / workers); this file keeps the
// folder helpers, the 9router model catalog, and re-exports the model API so
// older callers (bridges, status, new-app, the cam) keep working unchanged.
//
// Folder layout per worker:  workspaces/<worker-id>/{ inbox, apps, runs }

import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './state.js'
import {
  THEME,
  STAGES,
  STAGE_LABELS,
  STAGE_FALLBACK,
  SUGGESTED_WORKERS,
  DIV_COLORS,
  CEO_ROLE,
  defaultRoles,
  defaultDivisions,
  defaultWorkers,
  slugId,
  roleById,
  divisionById,
  workerModelRef,
  ensureRoleCatalog,
  syncWorkspaces,
  ensureModel,
  activeWorkerForStage,
  validateWorker
} from './model.js'

// The Digital Workers model API — re-exported for convenience.
export {
  THEME,
  STAGES,
  STAGE_LABELS,
  STAGE_FALLBACK,
  SUGGESTED_WORKERS,
  DIV_COLORS,
  CEO_ROLE,
  defaultRoles,
  defaultDivisions,
  defaultWorkers,
  slugId,
  roleById,
  divisionById,
  workerModelRef,
  ensureRoleCatalog,
  syncWorkspaces,
  ensureModel,
  activeWorkerForStage,
  validateWorker
}

// The model catalog (9router + OpenCode Zen + custom refs) — re-exported so
// every existing `from './workspaces.js'` caller keeps resolving unchanged.
export {
  MODEL_CATALOG,
  loadModelCatalog,
  saveModelCatalog,
  defaultModelRefs,
  loadAllModels,
  allModelRefs,
  freeModelRefs,
  addCustomModel,
  removeCustomModel,
  loadCustomModels,
  loadZenCatalog,
  gatewayState,
  saveGateway,
  syncModels,
  roleModel,
  modelSummary,
  TOOL_PAGES,
  OFFICE_PAGES,
  ZEN_PROVIDER,
  ZEN_FREE,
  ZEN_RETIRED,
  ZEN_ALL
} from './models.js'

export function workspacePath (ws) {
  return path.join(ROOT, 'workspaces', ws.id)
}

export function ensureWorkspaceDirs (ws) {
  for (const d of ['inbox', 'apps', 'runs']) {
    fs.mkdirSync(path.join(workspacePath(ws), d), { recursive: true })
  }
  const ag = path.join(workspacePath(ws), 'AGENTS.md')
  if (!fs.existsSync(ag)) {
    fs.writeFileSync(ag, [
      `# ${ws.name} worker (${THEME})`,
      '',
      `Role: **${ws.role}** — ${ws.description ?? ''}`,
      `Division: ${ws.division || 'core'}`,
      `Model: \`${ws.model}${ws.variant && ws.variant !== 'default' ? '#' + ws.variant : ''}\``,
      '',
      'You are a Digital Worker in this office. Stay in your role, scope your work to this',
      'workspace folder, and follow the office AGENTS.md rules in the project root.',
      ''
    ].join('\n'))
  }
}

/**
 * Upgrade settings to the Digital Workers model (roles/divisions/workers) and
 * make sure every worker has its folder and AGENTS.md. Returns settings.
 */
export function ensureAllWorkspaces (settings) {
  const s = ensureModel(settings)
  for (const w of s.workers) ensureWorkspaceDirs(w)
  return s
}

/** Legacy shape helper (kept for compatibility with older callers). */
export function defaultWorkspaces () {
  return defaultWorkers().map(w => ({
    id: w.id, name: w.name, role: w.role, agent: w.role,
    model: w.model, variant: w.variant, description: w.description
  }))
}

export function getWorkspace (settings, id) {
  const ws = (settings.workspaces || []).find(w => w.id === id)
  return ws || (settings.workspaces || [])[1] || (settings.workspaces || [])[0]
}

/** Effective model ref string for a worker: "provider/model#variant". */
export function workspaceModelRef (ws) {
  return workerModelRef(ws)
}