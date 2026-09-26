#!/usr/bin/env node
// discord.js — zero-dependency Discord bot that plugs the office into Discord.
// Uses the built-in WebSocket (Node >= 22) or the `ws` package if present.
//   DEBUG_DISCORD=1 node bridges/discord.js
//
// Commands in chat: !workspaces  !status  !new [workspace]  !ping

import { getClient, getSettings, sessionForChat, deleteMapping, truncate, officeKey, eventLine } from './bridge-common.js'
import { log } from '../lib/logger.js'

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const API = 'https://discord.com/api/v10'

async function getWs () {
  if (globalThis.WebSocket) return globalThis.WebSocket
  try { return (await import('ws')).default } catch { return null }
}

async function main () {
  const settings = getSettings()
  const discord = settings.integrations?.discord
  const token = discord?.token || process.env.DISCORD_BOT_TOKEN
  if (!discord?.enabled && !process.env.DISCORD_BOT_TOKEN) {
    log.warn('Discord bridge skipped (not enabled; run the wizard or set DISCORD_BOT_TOKEN)')
    process.exit(0)
  }
  if (!token) { log.error('Discord bot token missing'); process.exit(1) }
  const WS = await getWs()
  if (!WS) {
    log.error('No WebSocket available — run `npm install ws` or use Node >= 22.')
    process.exit(1)
  }

  const client = getClient()
  const channels = new Map() // serialized per-channel queue
  const chain = (key, fn) => {
    const prev = channels.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    channels.set(key, next.catch(() => {}))
    return next
  }

  async function reply (channelId, text) {
    await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: truncate(text, 1980) })
    }).catch(() => {})
  }

  // --- CEO notifications ----------------------------------------------------
  // The orchestrator publishes office events; we forward the important ones
  // (needs review / failed / done) to the CEO's notification channel.
  function notifyChannelId () {
    return process.env.DISCORD_NOTIFY_CHANNEL_ID || settings.integrations?.discord?.notifyChannelId || ''
  }
  let lastEventAt = 0
  async function pollEvents () {
    const ch = notifyChannelId()
    if (!ch) return
    try {
      const r = await fetch(`http://127.0.0.1:${settings.healthPort || 8099}/api/events?since=${lastEventAt || 0}`)
      const j = await r.json()
      for (const e of (j.events || [])) {
        lastEventAt = Math.max(lastEventAt, new Date(e.at).getTime())
        await reply(ch, eventLine(e))
      }
    } catch {}
  }
  setInterval(pollEvents, 10000)
  pollEvents()

  async function handleMessage (msg) {
    if (msg.author?.bot) return
    if (msg.type !== 0) return
    const content = (msg.content || '').trim()
    const key = msg.channel_id

    if (!content) return
    if (content.startsWith('!')) {
      const [cmd, ...rest] = content.split(/\s+/)
      if (cmd === '!ping') return reply(key, 'pong 🥒')
      if (cmd === '!workspaces') {
        const s = getSettings()
        const list = (s.workspaces || []).map(w => `- **${w.id}**: ${w.role} · \`${w.model}${w.variant ? '#' + w.variant : ''}\``).join('\n')
        return reply(key, `**Company office** (${s.theme})\n${list}`)
      }
      if (cmd === '!status') {
        try {
          const r = await fetch(`http://127.0.0.1:${settings.healthPort || 8099}/health`)
          const j = await r.json()
          return reply(key, `Orchestrator: ok · ${j.active}/${j.workers} workers busy · ${j.queued} queued · ${j.jobs} jobs total`)
        } catch (e) {
          return reply(key, `Orchestrator status unavailable: ${e.message}`)
        }
      }
      if (cmd === '!report') {
        // Ask the CEO assistant for a fresh office report.
        const rest = rest.join(' ').trim()
        try {
          const r = await fetch(`http://127.0.0.1:${settings.healthPort || 8099}/api/ceo/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-office-key': officeKey() },
            body: JSON.stringify({ kind: 'summary', question: rest || undefined })
          })
          const j = await r.json()
          if (!r.ok) return reply(key, `⚠️ ${j.error || 'report failed'}`)
          return reply(key, truncate(`📊 **Office report**\n\n${j.report}`, 1900))
        } catch (e) {
          return reply(key, `⚠️ report failed: ${e.message}`)
        }
      }
      if (cmd === '!new') {
        deleteMapping(key)
        return reply(key, `Fresh session started${rest.length ? ` in workspace **${rest[0]}**` : ''}. What shall we work on?`)
      }
    }

    const workspaceID = content.startsWith('!build ') ? content.split(/\s+/)[1] : undefined
    const text = workspaceID ? content.replace(/^!build\s+\S+\s*/, '') : content

    return chain(key, async () => {
      await reply(key, 'Thinking in the office…')
      try {
        const { sessionID } = await sessionForChat(client, key, { workspaceID, title: `discord #${key.slice(0, 8)}` })
        const answer = await client.promptAndWait(sessionID, text, { pollMs: 2500, timeoutMs: 20 * 60 * 1000 })
        await reply(key, answer)
      } catch (e) {
        log.error(`discord chat error: ${e.message}`)
        await reply(key, `⚠️ ${e.message}`)
      }
    })
  }

  // --- gateway plumbing -----------------------------------------------------
  let ws, heartbeat, resume = null
  const connect = () => {
    ws = new WS(DISCORD_GATEWAY)
    ws.onmessage = async ev => {
      const p = JSON.parse(ev.data)
      if (p.op === 10) {
        heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: p.d.heartbeat_interval })), p.d.heartbeat_interval)
        if (resume) ws.send(JSON.stringify({ op: 6, d: resume }))
        else ws.send(JSON.stringify({ op: 2, d: { token, intents: 33281, properties: { $os: process.platform, $browser: 'bigpickle', $device: 'bigpickle' } } }))
      } else if (p.op === 11) {
        // heartbeat ack
      } else if (p.op === 7) {
        clearInterval(heartbeat)
      } else if (p.op === 9) {
        clearInterval(heartbeat)
      } else if (p.op === 0) {
        if (p.t === 'READY') log.ok(`Discord online as ${p.d.user?.username}`)
        if (p.t === 'RESUMED') log.ok('Discord connection resumed')
        if (p.t === 'MESSAGE_CREATE') handleMessage(p.d)
      }
    }
    ws.onclose = () => {
      clearInterval(heartbeat)
      log.warn('Discord socket closed — reconnecting in 5s')
      setTimeout(connect, 5000)
    }
    ws.onerror = e => log.error('Discord ws error: ' + (e.message || e))
  }

  connect()
}

main().catch(e => { log.error(e); process.exit(1) })