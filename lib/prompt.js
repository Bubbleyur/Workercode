// prompt.js — interactive terminal widgets for the wizard:
//  - selectList(): arrow-key radio (●/○) or multi-select ([✓]/·)
//  - ask() / askSecret(): raw-mode text input (no readline — readline turns
//    raw mode off when it closes, which desynced the session and froze
//    the next list). Everything here shares ONE raw session.
//
// Raw mode is enabled on the first widget and held until endInteractive(),
// so Windows consoles never re-read stale keypresses between questions and
// no widget ever runs with the wrong terminal mode.
// Falls back to numbered prompts when stdin is not a TTY.

import readline from 'node:readline'

const IS_TTY = !!process.stdin.isTTY && !!process.stdout.isTTY
const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb'
const C = (n, s) => (NO_COLOR || !IS_TTY ? s : `\x1b[${n}m${s}\x1b[0m`)
export const cyan = s => C('36', s)
export const green = s => C('32', s)
export const yellow = s => C('33', s)
export const dim = s => C('90', s)
export const bold = s => C('1', s)

// ---- raw-mode session ------------------------------------------------------
// idempotent: re-asserts raw mode on every widget so a desync self-heals.
let sessionOn = false
function rawSession () {
  if (!IS_TTY || !process.stdin.setRawMode) return false
  sessionOn = true
  readline.emitKeypressEvents(process.stdin)
  try { process.stdin.setRawMode(true) } catch {}
  return true
}
export async function endInteractive () {
  if (sessionOn && process.stdin.setRawMode) {
    try { process.stdin.setRawMode(false) } catch {}
  }
  sessionOn = false
}

// ---- non-TTY fallback: one readline buffers every line ----------------------
let fallbackRL = null
let queued = []
let waiters = []
function ensureReader () {
  if (fallbackRL) return
  fallbackRL = readline.createInterface({ input: process.stdin, output: process.stdout })
  fallbackRL.on('line', l => {
    if (waiters.length) waiters.shift()(l)
    else queued.push(l)
  })
}
function fallbackQuestion (prompt) {
  ensureReader()
  process.stdout.write(prompt)
  if (queued.length) return Promise.resolve(queued.shift())
  return new Promise(res => waiters.push(res))
}

// ---- raw-mode single-line text input ---------------------------------------
function readRawLine (question, { secret = false, default: dflt = '' } = {}) {
  rawSession()
  const pre = '  ' + cyan('›') + ' ' + bold(question) + ' '
  return new Promise(resolve => {
    let buf = ''
    const render = () => {
      let shown
      if (buf) shown = secret ? '•'.repeat(buf.length) : buf
      else shown = !secret && dflt !== '' ? dim(`(${dflt})`) : ''
      process.stdout.write('\r\x1b[K' + pre + shown)
    }
    const submit = ans => {
      process.stdin.removeListener('keypress', handler)
      process.stdout.write('\n')
      resolve(ans.trim() === '' ? String(dflt) : ans.trim())
    }
    const quit = () => {
      process.stdin.removeListener('keypress', handler)
      process.stdout.write('\n')
      endInteractive().then(() => process.exit(0))
    }
    const handler = (ch, key) => {
      if (!key) return
      if (key.name === 'return' || key.name === 'enter') submit(buf)
      else if (key.name === 'backspace' && buf.length) { buf = buf.slice(0, -1); render() }
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) quit()
      else if (ch && !key.ctrl && !key.meta && key.name && key.name.length === 1) { buf += ch; render() }
    }
    process.stdin.on('keypress', handler)
    render()
  })
}

/**
 * Interactive list. options: { label, value?, hint? }[]
 * multiple=true toggles with Space and confirms with Enter.
 * Returns { value } for radio or { values: [] } for multi-select.
 */
export function selectList (question, options, { multiple = false, defaultIndex = 0, hint = '' } = {}) {
  rawSession()
  return new Promise(async resolve => {
    if (!IS_TTY) {
      // Non-interactive fallback: print numbered list, ask for a number.
      console.log('▸ ' + question)
      options.forEach((o, i) => console.log(`   ${i + 1}. ${o.label}${o.hint ? '  ' + dim(o.hint) : ''}`))
      const ans = await fallbackQuestion(`   ${multiple ? 'Numbers (comma-separated)' : 'Number'} to choose: `)
      const nums = ans.split(',').map(n => parseInt(n.trim(), 10) - 1).filter(i => i >= 0 && i < options.length)
      resolve(multiple
        ? { values: nums.map(i => options[i].value ?? options[i].label) }
        : { value: (options[nums[0] ?? 0] || {}).value ?? options[nums[0] ?? 0]?.label })
      return
    }

    if (options.length === 0) {
      resolve(multiple ? { values: [] } : { value: null, index: -1 })
      return
    }

    let cursor = Math.min(Math.max(defaultIndex, 0), options.length - 1)
    const selected = new Set(multiple && defaultIndex < options.length ? [defaultIndex] : [])
    let first = true
    let rows = 0

    const draw = () => {
      const lines = []
      lines.push('  ' + cyan('›') + ' ' + bold(question) + (hint ? '  ' + dim(hint) : ''))
      options.forEach((o, i) => {
        const cur = i === cursor
        const sel = multiple ? selected.has(i) : i === cursor
        const mark = multiple
          ? (sel ? green('✓') : dim('·'))
          : (sel ? green('●') : dim('○'))
        const cursorArrow = cur ? yellow('›') : ' '
        const label = cur ? bold(o.label) : o.label
        const hintTxt = o.hint ? dim('  — ' + o.hint) : ''
        lines.push(`  ${cursorArrow} ${mark} ${label}${hintTxt}`)
      })
      lines.push(dim(multiple ? '   ↑/↓ move · Space toggle · Enter done' : '   ↑/↓ move · Enter pick'))
      const out = lines.join('\n') + '\n'
      if (first) { process.stdout.write(out); first = false; rows = lines.length + 1 }
      else { process.stdout.write('\x1b[' + rows + 'A\x1b[J' + out); rows = lines.length + 1 }
    }

    const finish = (result, { quit = false } = {}) => {
      process.stdout.write('\x1b[' + rows + 'A\x1b[J')
      const summary = multiple
        ? (result.values.length ? result.values.join(', ') : dim('skipped'))
        : String(result.value ?? '')
      process.stdout.write('  ' + green('✓') + ' ' + dim(question) + ' ' + bold(summary) + '\n')
      resolve(result)
      if (quit) endInteractive().then(() => process.exit(0))
    }

    const handler = (ch, key) => {
      if (!key) return
      const n = options.length
      if (key.name === 'up') { cursor = (cursor - 1 + n) % n; draw() }
      else if (key.name === 'down') { cursor = (cursor + 1) % n; draw() }
      else if (key.name === 'space' && multiple) {
        if (selected.has(cursor)) selected.delete(cursor)
        else selected.add(cursor)
        draw()
      } else if (key.name === 'return' || key.name === 'enter') {
        process.stdin.removeListener('keypress', handler)
        if (multiple) {
          finish({ values: [...selected].sort((a, b) => a - b).map(i => options[i].value ?? options[i].label) })
        } else {
          finish({ value: options[cursor].value ?? options[cursor].label, index: cursor })
        }
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        process.stdin.removeListener('keypress', handler)
        finish({ value: null, aborted: true }, { quit: true })
      }
    }

    process.stdin.on('keypress', handler)
    draw()
  })
}

/** Radio single-choice: returns the chosen value. */
export async function menu (question, options, opts = {}) {
  const r = await selectList(question, options, { ...opts, multiple: false })
  return r.value
}

/** Multi-select with ✓ marks: returns array of chosen values. */
export async function multiselect (question, options, opts = {}) {
  const r = await selectList(question, options, { ...opts, multiple: true })
  return r.values ?? []
}

/** Yes/No via arrow keys. Returns boolean. */
export async function yn (question, def = false) {
  const r = await selectList(question, [
    { label: 'Yes', value: true },
    { label: 'No', value: false }
  ], { defaultIndex: def ? 0 : 1 })
  return r.value !== false
}

/** Styled text input. Returns trimmed string or the default. */
export function ask (question, { default: dflt = '' } = {}) {
  if (!IS_TTY) {
    const pre = '  ' + cyan('›') + ' ' + bold(question) + (dflt !== '' ? dim(` [${dflt}]`) : '') + ' '
    return fallbackQuestion(pre).then(ans => (ans.trim() === '' ? String(dflt) : ans.trim()))
  }
  return readRawLine(question, { default: dflt })
}

/** Hidden text input (no echo). */
export function askSecret (question) {
  if (!IS_TTY) {
    const pre = '  ' + cyan('›') + ' ' + bold(question) + dim(' (hidden):') + ' '
    return fallbackQuestion(pre).then(ans => ans.trim())
  }
  return readRawLine(question, { secret: true })
}

/** Section header. */
export function section (title, step, total) {
  const n = step ? dim(`  [${step}/${total}]`) : ''
  process.stdout.write('\n  ' + cyan('─'.repeat(2) + ' ') + bold(title) + n + '\n')
}

export default { selectList, menu, multiselect, yn, ask, askSecret, section, endInteractive }