// bridge-common.js — shared glue for chat bridges: chat <-> OpenCode sessions.
// Each chat (Discord channel, WhatsApp JID) maps to a persistent session in a
// workspace, so conversations keep context and the agent builds things on request.

import fs from 'node:fs'
import path from 'node:path'
import { OpenCodeClient } from '../lib/api.js'
import { loadSettings, CONFIG_DIR, serverUrl, readPassword } from '../lib/state.js'
import { ensureAllWorkspaces, workspaceModelRef, getWorkspace } from '../lib/workspaces.js'

const MAPPING_FILE = path.join(CONFIG_DIR, 'bridge-sessions.json')
let mapping = {}

export function loadMapping () {
  try { mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8')) } catch { mapping = {} }
}
export function saveMapping () {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2))
}
export function getMapping (chatKey) { return mapping[chatKey] }
export function setMapping (chatKey, entry) { mapping[chatKey] = entry; saveMapping() }
export function deleteMapping (chatKey) { delete mapping[chatKey]; saveMapping() }

/** Return a client pointing at the always-on server. */
export function getClient () {
  const settings = ensureAllWorkspaces(loadSettings(true))
  return new OpenCodeClient(serverUrl(settings), readPassword())
}

export function getSettings () {
  return ensureAllWorkspaces(loadSettings(true))
}

/** The office key (x-office-key) so bridges can call the mutating API. */
export function officeKey () {
  return process.env.BIGPICKLE_TOKEN || readPassword()
}

/** Which office events the CEO wants pushed to chat. */
export const CEO_NOTIFY_EVENTS = new Set(['build.needs-review', 'build.failed', 'build.done', 'ceo.notice'])

/** Pretty one-liner for a CEO notification. */
export function eventLine (e) {
  const icon = { 'build.needs-review': '🛑', 'build.failed': '⚠️', 'build.done': '✅', 'ceo.notice': '📣' }[e.type] || '•'
  return `${icon} ${e.message}`
}

/**
 * Get (or create) the session for a chat, bound to a workspace.
 * workspaceId defaults to "engineering" when absent via getWorkspace().
 */
export async function sessionForChat (client, chatKey, opts = {}) {
  const settings = ensureAllWorkspaces(loadSettings(true))
  const existing = getMapping(chatKey)
  if (existing?.sessionID) {
    try {
      await client.getSession(existing.sessionID)
      return { sessionID: existing.sessionID, workspaceID: existing.workspaceID, created: false }
    } catch {
      deleteMapping(chatKey)
    }
  }
  const ws = getWorkspace(settings, opts.workspaceID)
  const session = await client.createSession({
    title: opts.title || `[${ws.id}] chat ${chatKey}`,
    agent: ws.agent,
    model: workspaceModelRef(ws)
  })
  setMapping(chatKey, { sessionID: session?.id, workspaceID: ws.id })
  return { sessionID: session?.id, workspaceID: ws.id, created: true }
}

export function truncate (text, n = 1900) {
  if (!text) return text
  return text.length > n ? text.slice(0, n - 3) + '...' : text
}