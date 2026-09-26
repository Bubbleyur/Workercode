// api.js — tiny OpenCode REST client using fetch + HTTP Basic auth.
// The 24/7 server (`opencode serve`) requires Basic auth with username "opencode"
// and the random password it prints on startup (we persist it in config/server.password).

import { readPassword, serverUrl } from './state.js'

/** Parse "provider/model" or "provider/model#variant" into a Model.Ref. */
export function modelRef (ref) {
  if (!ref) return undefined
  if (typeof ref !== 'string') return ref
  const [full, variant] = ref.split('#')
  const slash = full.indexOf('/')
  if (slash <= 0) return { id: full }
  const providerID = full.slice(0, slash)
  const modelID = full.slice(slash + 1)
  const o = { id: full, providerID, modelID }
  if (variant) o.variant = variant
  return o
}

export class OpenCodeClient {
  constructor (base, password) {
    this.base = base || serverUrl()
    this.password = password || readPassword()
  }

  authHeader () {
    const cred = `opencode:${this.password}`
    return 'Basic ' + Buffer.from(cred, 'utf8').toString('base64')
  }

  async request (method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (res.status === 401) throw new Error(`Authentication failed for ${this.base} — is config/server.password current?`)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`API ${method} ${path} -> ${res.status}: ${txt.slice(0, 300)}`)
    }
    if (res.status === 204) return null
    const json = await res.json().catch(() => ({}))
    return json.data ?? json
  }

  /** GET /api/info — liveness probe against the always-on server. */
  async health () {
    return this.request('GET', '/api/info')
  }

  async listSessions () {
    return this.request('GET', '/api/session')
  }

  /**
   * Create a session. Scope it to `directory`, assign an `agent` and a
   * `model` ref ("9router/oc/union-alpha#high", or a Model.Ref object).
   */
  async createSession ({ title, directory, agent, model }) {
    const body = { title }
    if (directory) body.location = { directory }
    if (agent) body.agent = agent
    const m = modelRef(model)
    if (m) body.model = m
    return this.request('POST', '/api/session', body)
  }

  /** Send a user message. Returns the user message record. */
  async sendPrompt (sessionID, text) {
    return this.request('POST', `/api/session/${sessionID}/prompt`, { text })
  }

  async setModel (sessionID, model) {
    return this.request('POST', `/api/session/${sessionID}/model`, { model: modelRef(model) })
  }

  async setAgent (sessionID, agent) {
    return this.request('POST', `/api/session/${sessionID}/agent`, { agent })
  }

  /** Sessions currently working ({"<id>":{"type":"running"}}). A session
   *  disappears from this map once its turn finishes — our "done" signal. */
  async activeSessions () {
    return this.request('GET', '/api/session/active')
  }

  async messages (sessionID) {
    return this.request('GET', `/api/session/${sessionID}/message`)
  }

  async getSession (sessionID) {
    return this.request('GET', `/api/session/${sessionID}`)
  }

  async interrupt (sessionID) {
    return this.request('POST', `/api/session/${sessionID}/interrupt`)
  }

  /**
   * Send a prompt and block until the session is idle again.
   * Returns the last assistant text reply (or '' if none).
   */
  async promptAndWait (sessionID, text, { pollMs = 3000, timeoutMs = 3600000, onBusy } = {}) {
    await this.sendPrompt(sessionID, text)
    const started = Date.now()
    while (true) {
      const active = await this.activeSessions()
      const busy = !!active[sessionID]
      if (onBusy) await onBusy(busy)
      if (!busy) break
      if (Date.now() - started > timeoutMs) {
        await this.interrupt(sessionID).catch(() => {})
        throw new Error(`Session ${sessionID} timed out after ${Math.round((Date.now() - started) / 1000)}s`)
      }
      await new Promise(r => setTimeout(r, pollMs))
    }
    return extractLastReply(await this.messages(sessionID))
  }
}

/** Pull the most recent assistant text out of a messages() response. */
export function extractLastReply (messages) {
  const list = Array.isArray(messages) ? messages : messages?.messages ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.type === 'assistant') {
      const content = m.content || []
      for (let j = content.length - 1; j >= 0; j--) {
        const c = content[j]
        if (c && c.type === 'text' && c.text) return c.text
      }
      if (m.text) return m.text
      if (m.summary?.text) return m.summary.text
    }
  }
  return '_(no response)_'
}

export default OpenCodeClient