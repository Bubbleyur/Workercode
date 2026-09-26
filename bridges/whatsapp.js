#!/usr/bin/env node
// whatsapp.js — WhatsApp bridge for the office.
//
// QR mode (default): uses Baileys and prints an ASCII QR code to the terminal
//   (WhatsApp Web pairing) — scan it with your phone right away.
//   Requires: npm run deps:whatsapp   (@whiskeysockets/baileys)
//
// Token mode (Cloud API): WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID — replies
//   go out over the Graph API; inbound needs a public webhook, so prefer QR
//   mode on a VPS without a public URL.

import path from 'node:path'
import { getClient, getSettings, sessionForChat, truncate, officeKey, eventLine } from './bridge-common.js'
import { log } from '../lib/logger.js'
import { CONFIG_DIR } from '../lib/state.js'

let baileys = null
function getBaileys () {
  if (baileys) return baileys
  try {
    const m = awaitImport('@whiskeysockets/baileys')
    baileys = m
    return m
  } catch {
    return null
  }
}
async function awaitImport (name) { return import(name) }

async function main () {
  const settings = getSettings()
  const wa = settings.integrations?.whatsapp
  if (!wa?.enabled && !process.env.WHATSAPP_TOKEN) {
    log.warn('WhatsApp bridge skipped (not enabled; run the wizard)')
    process.exit(0)
  }

  const client = getClient()

  if (wa?.method === 'token') return runTokenMode(wa, client)

  const b = await getBaileys()
  if (!b) {
    log.error('Baileys is not installed. Run:  npm run deps:whatsapp')
    process.exit(1)
  }
  return runQrMode(b, client)
}

async function runTokenMode (wa, client) {
  const token = wa.token || process.env.WHATSAPP_TOKEN
  const phoneNumberId = wa.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneNumberId) {
    log.error('WhatsApp token + phone number ID required for token mode')
    process.exit(1)
  }
  log.ok('WhatsApp Cloud API mode active (outbound). Inbound needs a public webhook — use QR mode without one.')
  // Kept alive as an outbound client; extend for webhooks at your phone-number endpoint.
  setInterval(() => {}, 1 << 30)
}

async function runQrMode ({ makeWASocket, useMultiFileAuthState, DisconnectReason }, client) {
  const settings = getSettings()
  const sessionDir = path.join(CONFIG_DIR, 'whatsapp-session')
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const sock = makeWASocket({
    printQRInTerminal: true, // prints the ASCII QR immediately — scan with the phone
    auth: state,
    browser: ['Big Pickle', 'Office', '24/7']
  })
  sock.ev.on('creds.update', saveCreds)
  log.ok('WhatsApp bridge started — QR code printed above, scan it with your phone right away')

  sock.ev.on('connection.update', u => {
    if (u.connection === 'open') log.ok(`WhatsApp online as ${sock.user?.id || 'connected'}`)
    if (u.lastDisconnect?.error) {
      const status = u.lastDisconnect.error?.output?.payload?.statusCode
      const fatal = status === DisconnectReason.loggedOut || status === DisconnectReason.badSession
      log.warn(`WhatsApp disconnected (code ${status}).` + (fatal ? ' Delete config/whatsapp-session and restart to re-pair.' : ' Reconnecting…'))
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid?.endsWith('@g.us')) continue // groups are off by default
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
      if (!text.trim()) continue
      const jid = msg.key.remoteJid
      const chatKey = `wa:${jid}`

      // !report — ask the CEO assistant for an office summary.
      if (text.trim() === '!report' || text.trim().startsWith('!report ')) {
        const question = text.trim().slice(7).trim()
        try {
          const r = await fetch(`http://127.0.0.1:${settings.healthPort || 8099}/api/ceo/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-office-key': officeKey() },
            body: JSON.stringify({ kind: 'summary', question: question || undefined })
          })
          const j = await r.json()
          if (!r.ok) await sock.sendMessage(jid, { text: `⚠️ ${j.error || 'report failed'}` })
          else await sock.sendMessage(jid, { text: truncate(`📊 *Office report*\n\n${j.report}`, 3800) })
        } catch (e) {
          await sock.sendMessage(jid, { text: `⚠️ report failed: ${e.message}` })
        }
        continue
      }

      try {
        const { sessionID } = await sessionForChat(client, chatKey, { title: `whatsapp ${String(jid).slice(0, 12)}` })
        const answer = await client.promptAndWait(sessionID, text, { pollMs: 2500, timeoutMs: 20 * 60 * 1000 })
        await sock.sendMessage(jid, { text: truncate(answer, 3900) })
      } catch (e) {
        log.error(`whatsapp chat error: ${e.message}`)
        await sock.sendMessage(jid, { text: `⚠️ ${e.message}` })
      }
    }
  })

  // --- CEO notifications ----------------------------------------------------
  // Forward office events (needs review / failed / done / CEO notices) to the
  // CEO's own number so the office reports in even when the CEO is away.
  function ceoJid () {
    return process.env.WHATSAPP_CEO_JID || settings.integrations?.whatsapp?.ceoJid || ''
  }
  let lastEventAt = 0
  async function pollEvents () {
    const to = ceoJid()
    if (!to) return
    try {
      const r = await fetch(`http://127.0.0.1:${settings.healthPort || 8099}/api/events?since=${lastEventAt || 0}`)
      const j = await r.json()
      for (const e of (j.events || [])) {
        lastEventAt = Math.max(lastEventAt, new Date(e.at).getTime())
        await sock.sendMessage(to, { text: truncate(eventLine(e), 3800) })
      }
    } catch {}
  }
  setInterval(pollEvents, 10000)
  pollEvents()
}

main().catch(e => { log.error(e); process.exit(1) })