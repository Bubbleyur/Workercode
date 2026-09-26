// pipeline.js — the Digital Workers SDLC pipeline: Plan → Build → Review →
// Test → Deploy, run autonomously per division with evaluation at every stage.
//
// Each stage:
//   1. picks an active worker for the stage (division-first, then fallback
//      chain, see activeWorkerForStage) — skipped + recorded if none exists
//   2. runs that worker's agent+model on the app folder with a stage prompt
//      (plan produces DESIGN.md + .bp/stages.json with per-stage prompts;
//      other stages read that pack or fall back to built-in prompts)
//   3. evaluates the output: auto-checks (files, syntax, tests, secrets) plus
//      an AI rubric score 0-100 from the reviewer worker
//   4. score ≥ evalThreshold & no hard auto-check failures → stage done;
//      otherwise retry with the critique fed back (evalRetries times); after
//      that the job pauses in `needs-review` for a human (approve / reject /
//      retry) instead of failing silently.
//
// The engine is pure-ish: everything external (the OpenCode client, dry-run
// client, settings, logging, persistence) comes through the ctx object, so it
// also runs in test/dry-run mode without a live provider.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { STAGES, STAGE_LABELS, activeWorkerForStage, workerModelRef } from './model.js'

/** The file each stage is expected to produce. */
export const STAGE_OUTPUT = {
  plan: 'DESIGN.md',
  build: 'BUILD_REPORT.md',
  review: 'REVIEW.md',
  test: 'TEST_REPORT.md',
  deploy: 'DEPLOY.md'
}

export function stageLabel (stage) {
  return STAGE_LABELS[stage] || stage
}

/** Built-in prompt for every stage (used when plan didn't produce a pack). */
export function defaultPromptPack (job) {
  const goal = job.description || job.name || 'this app'
  const base = [
    `Goal: ${goal}`,
    job.name ? `App name: ${job.name}` : '',
    `Division: ${job.division || 'core'}`,
    'Stay inside the job folder, keep the app self-contained, follow AGENTS.md.',
    "You work for Big Pickle. Your user is the CEO — this build is their order, and your report goes straight to them.",
    job.clientsNote ? `Client note: ${job.clientsNote}` : ''
  ].filter(Boolean).join('\n')
  return {
    plan: `Architect this app. Write DESIGN.md (concise — structure, data, APIs, dependencies) and a \`.bp/stages.json\` with your per-stage prompts for build / review / test / deploy.\n\n${base}`,
    build: `Implement the app. Read DESIGN.md and .bp/stages.json first if present, then code it, write a README.md, add sensible tests, and finish by writing BUILD_REPORT.md (what was built, how to run it, what is unfinished).\n\n${base}`,
    review: `Review the implementation for correctness, security, completeness vs the goal and missing tests. Write REVIEW.md with concrete findings and fixes. End with a line: SCORE: <0-100> and CRITIQUE: <short summary>.\n\n${base}`,
    test: `Test the implementation. Run whatever checks/tests exist, add tests where missing, fix obvious bugs if reasonable, and record results in TEST_REPORT.md.\n\n${base}`,
    deploy: `Finalize the release. Produce a clean build/package for the app (e.g. dist/ or a zip), write DEPLOY.md with how to run and preview it, and prepare anything needed for local serving. Do not push to remote repositories.\n\n${base}`
  }
}

/** Read .bp/stages.json if the plan stage produced one; merge over fallbacks. */
export function loadPromptPack (dir, fallback) {
  try {
    const file = path.join(dir, '.bp', 'stages.json')
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      const pack = { ...fallback }
      for (const st of STAGES) {
        if (typeof d[st] === 'string' && d[st].trim()) pack[st] = d[st].trim()
      }
      return pack
    }
  } catch {}
  return fallback
}

/** Which stages a job runs. A manifest may limit them; default = all five. */
export function jobStages (job) {
  if (Array.isArray(job.stages) && job.stages.length) {
    return job.stages.filter(s => STAGES.includes(s))
  }
  return [...STAGES]
}

/** Recursively list app files (relative), skipping heavy/binary dirs. */
function walk (dir, out = [], base = '') {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (['node_modules', '.git', '.bp', 'dist', 'runs'].includes(e.name)) continue
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) walk(path.join(dir, e.name), out, rel)
    else out.push(rel)
  }
  return out
}

const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|java|html|css|json|md|txt|yml|yaml|toml|sh|ps1|sql)$/i
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/

/** Best-effort automated checks for a finished stage. Each check:
 *  { check, pass, detail, must } — `must:false` entries are informational. */
export function autoChecks (dir, stage, job, { timeoutMs = 60000 } = {}) {
  const list = []
  const push = (name, detail, pass, must = true) => list.push({ check: name, pass, detail, must })
  const has = (...names) => names.some(n => fs.existsSync(path.join(dir, n)))
  const read = p => { try { return fs.readFileSync(path.join(dir, p), 'utf8') } catch { return '' } }
  const files = walk(dir)
  const jsFiles = files.filter(f => /\.(js|mjs|cjs)$/.test(f) && !f.includes('node_modules'))

  switch (stage) {
    case 'plan': {
      const design = read('DESIGN.md')
      push('design.md', 'DESIGN.md produced by the architect', has('DESIGN.md'))
      push('design depth', `DESIGN.md has substance (${design.length} chars)`, design.trim().length > 200)
      break
    }
    case 'build': {
      const src = files.filter(f => TEXT_EXT.test(f) && !f.startsWith('.bp') && f !== 'BUILD_REPORT.md').length
      push('source files', `${src} source file(s) present`, src >= 2)
      const bad = []
      for (const f of jsFiles.slice(0, 40)) {
        let r
        try { r = spawnSync(process.execPath, ['--check', path.join(dir, f)], { timeout: 20000, encoding: 'utf8' }) } catch { r = { status: 1 } }
        if (r.status !== 0) { bad.push(`${f}: ${(r.stderr || '').split('\n')[0]}`) }
      }
      push('syntax', bad.length ? bad.join('; ').slice(0, 300) : `${jsFiles.length} JS file(s) parse clean`, bad.length === 0)
      push('readme', 'README.md present', has('README.md'))
      break
    }
    case 'review': {
      push('review.md', 'REVIEW.md produced by the reviewer', has('REVIEW.md'))
      push('review depth', `REVIEW.md has substance (${read('REVIEW.md').length} chars)`, read('REVIEW.md').trim().length > 100)
      break
    }
    case 'test': {
      const tests = files.filter(f => /(^|[/_-])(test|spec)(s)?([/._-]|$)|\.(test|spec)\./i.test(f)).length
      push('tests written', `${tests} test file(s) found`, tests > 0)
      const pkg = (() => { try { return JSON.parse(read('package.json')) } catch { return null } })()
      const hasDeps = fs.existsSync(path.join(dir, 'node_modules'))
      if (pkg?.scripts?.test && hasDeps) {
        let run
        try {
          run = spawnSync('npm', ['test', '--if-present', '--silent'], { cwd: dir, timeout: timeoutMs, encoding: 'utf8', shell: process.platform === 'win32' })
        } catch { run = { status: 1 } }
        push('npm test', run.status === 0 ? 'tests pass' : (run.stderr || run.stdout || 'tests failed').toString().split('\n').slice(0, 2).join(' ').slice(0, 300), run.status === 0)
      } else if (pkg?.scripts?.test) {
        push('npm test', 'skipped — node_modules not installed (informational)', true, false)
      }
      break
    }
    case 'deploy': {
      push('deploy.md', 'DEPLOY.md produced by the deployer', has('DEPLOY.md'))
      const pkgArtifact = fs.existsSync(path.join(dir, 'dist')) || files.some(f => f.toLowerCase().endsWith('.zip'))
      push('artifact', pkgArtifact ? 'build artifact present (dist/ or *.zip)' : 'no dist/ or zip artifact found', pkgArtifact)
      break
    }
  }

  // universal: no obvious secrets committed into the app folder
  const leak = []
  for (const f of files.slice(0, 60)) {
    if (!TEXT_EXT.test(f)) continue
    const txt = read(f)
    if (txt && txt.length < 500000 && SECRET_RE.test(txt)) { leak.push(f); if (leak.length >= 5) break }
  }
  push('secrets', leak.length ? `possible secret in: ${leak.join(', ')}` : 'no obvious secrets in app files', leak.length === 0)

  return list
}

/** Parse a reviewer reply into { score, critique } (JSON or SCORE:/CRITIQUE:). */
export function parseScore (text) {
  if (!text) return null
  let m = text.match(/\{[^{}]*"score"\s*:\s*\d+[^{}]*\}/i)
  if (m) {
    try {
      const o = JSON.parse(m[0].replace(/,\s*}/, '}'))
      if (typeof o.score === 'number' && Number.isFinite(o.score)) {
        return { score: Math.max(0, Math.min(100, Math.round(o.score))), critique: String(o.critique || o.reason || '').slice(0, 1000) }
      }
    } catch {}
  }
  m = text.match(/SCORE:\s*(\d{1,3})/i)
  if (m) {
    const crit = text.match(/CRITIQUE:\s*([\s\S]*)/i)
    return { score: Math.max(0, Math.min(100, parseInt(m[1], 10))), critique: (crit ? crit[1].slice(0, 1000) : '') }
  }
  return null
}

/** One evaluation round for a stage (auto checks + AI rubric score). */
export async function evaluateStage ({ job, stage, ctx, attempt }) {
  const { settings } = ctx
  const auto = autoChecks(job.dir, stage, job, { timeoutMs: settings.evalTimeoutMs || 60000 })
  const hardFail = auto.filter(a => a.pass === false && a.must !== false)

  let score = null
  let critique = ''
  const scorer = activeWorkerForStage(settings, 'review', job.division)
  if (scorer) {
    const rubric = [
      `You are the quality reviewer. Evaluate the "${stageLabel(stage)}" stage output for the app "${job.name}".`,
      `Goal: ${job.description || job.name || '(not specified)'}`,
      'The app folder is your working directory — skim the files.',
      'Rate 0-100 for: completeness vs the goal, quality, docs, tests.',
      'Reply with ONLY JSON: {"score": <0-100>, "critique": "<short, specific>"}'
    ].join('\n')
    try {
      const reply = await ctx.runScorer && await ctx.runScorer(scorer, job, rubric)
      const parsed = parseScore(reply)
      if (parsed) {
        score = parsed.score
        critique = parsed.critique
      }
    } catch (e) {
      critique = `scorer error: ${e.message}`
    }
  }

  const threshold = settings.evalThreshold ?? 70
  const passed = hardFail.length === 0 && (score === null || score >= threshold)
  return {
    stage,
    attempt,
    worker: '', // filled in by runStage with the stage's worker
    scorer: scorer?.worker?.id || '',
    autoChecks: auto,
    aiScore: score,
    critique: critique || (hardFail.length ? 'hard auto-check failures' : ''),
    threshold,
    passed,
    at: new Date().toISOString()
  }
}

/** Runtime + evaluation for one stage. Returns null when the stage passed,
 *  or a failure record. */
async function runStage (job, stage, pick, ctx) {
  const { client, settings, log, save } = ctx
  const pollMs = settings.pollMs || 3000
  const timeoutMs = 6 * 60 * 60 * 1000
  const maxAttempts = 1 + (settings.evalRetries ?? 2)
  // Load the stage prompts fresh each attempt: the plan stage writes
  // .bp/stages.json during the pipeline, so later stages must see it.
  const pack = loadPromptPack(job.dir, defaultPromptPack(job))
  ctx.pack = pack
  const promptOf = attempt => {
    const base = pack[stage] || pack.build
    return attempt > 1 && job.lastCritique
      ? `${base}\n\nPrevious attempt feedback — address these:\n${job.lastCritique}`
      : base
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (job.cancelReq || job.pauseReq) return { paused: true }
    job.attempts++
    job.stageStarted = new Date().toISOString()
    job.activeWorker = pick.worker.id
    job.stage = stage
    if (!job.evaluations) job.evaluations = []
    save()
    log(`[${job.id}] ${stageLabel(stage)} attempt ${attempt} → ${pick.worker.name} (${pick.worker.role}, ${pick.role.agent || pick.worker.role}@${workerModelRef(pick.worker) || 'default'})`)

    let ev
    try {
      const session = await client.createSession({
        title: `[${job.id} ${stageLabel(stage)}] ${job.name}`,
        directory: job.dir,
        agent: pick.role.agent || pick.worker.role,
        model: workerModelRef(pick.worker) || settings.model
      })
      job.sessionID = session?.id
      save()
      const reply = await client.promptAndWait(session?.id, promptOf(attempt), { pollMs, timeoutMs })
      ev = await evaluateStage({ job, stage, ctx, attempt })
      ev.autoChecks = ev.autoChecks || []
      ev.worker = pick.worker.id
      ev.replyPreview = (reply || '').slice(0, 160)
      job.evaluations.push(ev)
      save()
    } catch (e) {
      ev = {
        stage, attempt, worker: pick.worker.id, autoChecks: [], aiScore: null,
        critique: e.message, threshold: settings.evalThreshold ?? 70, passed: false,
        error: true, at: new Date().toISOString()
      }
      job.evaluations.push(ev)
      job.error = e.message
      save()
    }

    if (ev.error) {
      log(`[${job.id}] ${stageLabel(stage)} attempt ${attempt} failed: ${ev.critique}`)
      if (attempt >= maxAttempts) {
        return { failed: ev, message: ev.critique }
      }
      job.lastCritique = ev.critique
      continue
    }
    if (ev.passed) {
      log(`[${job.id}] ${stageLabel(stage)} passed (score ${ev.aiScore ?? 'n/a'}, ${ev.autoChecks.filter(a => a.pass).length}/${ev.autoChecks.length} checks)`)
      return { ok: true, ev }
    }
    log(`[${job.id}] ${stageLabel(stage)} attempt ${attempt} below threshold (score ${ev.aiScore ?? 'n/a'} < ${ev.threshold}, ${ev.autoChecks.filter(a => !a.pass).length} failing auto-checks)`)
    if (attempt >= maxAttempts) {
      return { failed: ev, message: ev.critique || `score ${ev.aiScore} below threshold after ${maxAttempts} attempts` }
    }
    job.lastCritique = ev.critique || 'no specific critique given — re-review the goal and quality bar'
  }
  return { failed: true, message: 'unexpected end of stage loop' }
}

/**
 * Run the full pipeline for a job. Starts at job.stageCursor (so resumed /
 * approved jobs continue where they stopped). Stops and leaves the job in
 * `needs-review` (waiting for a human) when a stage can't pass after retries.
 */
export async function runPipeline (job, ctx) {
  const { settings, log, save } = ctx
  ctx.pack = loadPromptPack(job.dir, defaultPromptPack(job))
  job.promptPack = ctx.pack

  const stages = jobStages(job)
  const startIndex = Math.max(0, parseInt(job.stageCursor, 10) || 0)
  job.stageCursor = startIndex
  job.status = 'running'
  job.finishedAt = ''
  job.waitingStage = ''
  save()

  for (let i = startIndex; i < stages.length; i++) {
    if (job.cancelReq) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); save(); return }
    if (job.pauseReq) { job.status = 'paused'; save(); return }

    const stage = stages[i]
    job.stage = stage
    job.stageCursor = i
    const pick = activeWorkerForStage(settings, stage, job.division)

    if (!pick) {
      if (!job.evaluations) job.evaluations = []
      job.evaluations.push({
        stage, attempt: 0, worker: '', autoChecks: [],
        aiScore: null, critique: '', passed: false, skipped: true,
        reason: `no active worker for ${stageLabel(stage)}`,
        at: new Date().toISOString()
      })
      if (job.stageStatus) job.stageStatus[stage] = 'skipped'
      save()
      log(`[${job.id}] ${stageLabel(stage)} skipped — no active worker (${job.division || 'any'})`)
      continue
    }

    const result = await runStage(job, stage, pick, ctx)
    if (result.paused) break
    if (result.failed) {
      job.status = 'needs-review'
      job.waitingStage = stage
      job.error = result.message
      job.finishedAt = new Date().toISOString()
      job.approvedStage = ''
      save()
      log(`[${job.id}] paused at ${stageLabel(stage)} — retries exhausted, needs human review`)
      ctx.event?.('build.needs-review', `"${job.name}" is waiting for the CEO at ${stageLabel(stage)} — ${(result.message || '').slice(0, 120)}`, { jobId: job.id, jobName: job.name, stage })
      return
    }
    if (job.stageStatus) job.stageStatus[stage] = 'done'
    log(`[${job.id}] ${stageLabel(stage)} done`)
    save()
  }

  if (job.cancelReq) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); save(); return }
  if (job.pauseReq) { job.status = 'paused'; save(); return }

  job.status = 'done'
  job.stage = 'done'
  job.finishedAt = job.finishedAt || new Date().toISOString()
  save()
  log(`[${job.id}] DONE "${job.name}" ${((job.finishedAt && job.startedAt) ? `in ${Math.round((new Date(job.finishedAt) - new Date(job.startedAt)) / 1000)}s` : '')}`)
  ctx.event?.('build.done', `"${job.name}" is DONE — all stages passed`, { jobId: job.id, jobName: job.name, division: job.division })
}