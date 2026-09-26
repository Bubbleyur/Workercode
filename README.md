# Big Pickle — 24/7 OpenCode app factory for VPS

A self-contained, cross-platform (Linux + Windows) setup that turns OpenCode
into an **always-on app-building office** that works like a live agency:

- one `opencode serve` **web session on localhost** (open `http://localhost:4096` in a browser),
- a **"company office" of workspaces** — one per model + role (architect, builder, reviewer, deployer),
- an **orchestrator** that watches folders and builds **many apps in parallel, 24/7**,
- a pixel-art **office cam** web page (rooftop view) showing every AI worker live — running, idle, or **out of token**,
- **Discord + WhatsApp bridges** so you can talk to the office from chat,
- a **CEO assistant** — reports, CEO↔worker notices, and build alerts in chat,
- **every model in one catalog**: OpenCode Zen's free tier out of the box, plus 9router, plus any ref you add,
- installs as real OS services (systemd / NSSM) so it survives reboots.

```
        ┌──────────────────────────── your VPS ────────────────────────────┐
        │                                                                 │
   run  │   node index.js  ── wizard (port, key, roles, integrations)      │
        │        │                                                        │
        │   ┌────▼────────────────────  opencode serve  ────────────────┐ │
        │   │  sessions ∧ web UI  →  http://localhost:4096              │ │
        │   └──────────────┬───────────────────────────▲────────────────┘ │
        │                  │ HTTP API (Basic auth)     │                  │
        │   ┌──────────────▼─────────────────┐  ┌──────┴─────────┐        │
        │   │ orchestrator (workers)         │  │ Discord bot    │        │
        │   │ inbox/ → apps/ per workspace   │  │ WhatsApp bridge│        │
        │   └────────────────────────────────┘  └────────────────┘        │
        └─────────────────────────────────────────────────────────────────┘
```

> **Theme: company office.** `strategy` plans, `engineering` builds,
> `quality` reviews, `delivery` ships — each with its own model.

---

## Quick start

Prerequisites: **Node.js ≥ 18** and **OpenCode v2** (`opencode --version`).

```bash
# 1. bootstrap (installs Node + OpenCode + deps if missing)
bash scripts/bootstrap.sh                 # Linux / macOS (Windows: bootstrap.ps1)

# 2. questionnaire — port, model gateway, workers, Discord / WhatsApp
node index.js --wizard

# 3. open the office (Ctrl+C stops; use services below for 24/7)
node index.js
```

You get:

```
Web session     http://127.0.0.1:4096        <- open this in a browser
Username        opencode
Password        <printed / config/server.password>
Control center  http://127.0.0.1:8099/panel  <- office staff · CEO office · new build · jobs · evaluation · models & tools
Office cam      http://127.0.0.1:8099/       <- clean rooftop view of the workers
```

> **No API key?** Skip step 2's gateway question and the office still runs — the
> role defaults are [OpenCode Zen](https://opencode.ai/zen) free models
> (`opencode/…`). Add a key later from the **Models & Tools** tab.

Everything runs as one process tree; `node index.js` shuts them down together.
For a zero-terminal survivors-reboot setup:

```bash
npm run install:service    # systemd (Linux) or NSSM (Windows)
npm run status             # one-line health of server + orchestrator + jobs
npm run logs               # tail the office logs
```

---

## 1 · The localhost web session

`opencode serve` binds to `127.0.0.1:<port>` (default **4096**) and serves the
OpenCode web UI. Credentials are printed on startup and cached in
`config/server.password` (Basic auth, user `opencode`).

- To reach a remote VPS safely: `ssh -L 4096:127.0.0.1:4096 user@vps` and open
  `http://localhost:4096`.
- To expose a custom origin for the web client: add `cors: ["https://app.example.com"]` to `config/settings.json`.
- Restart policy is handled by `Restart=always` (systemd) / `AppExit Restart`
  (NSSM) when installed as services.

## 2 · The company office — many models, many roles

Every workspace = **role (agent) + model + its own folders**:

| Workspace     | Role          | Default model (free tier)                       |
|---------------|---------------|--------------------------------------------------|
| strategy      | architect     | `opencode/big-pickle`                            |
| engineering   | builder       | `opencode/big-pickle`                            |
| quality       | reviewer      | `opencode/muse-spark-1.3-contributor-free`       |
| testing       | tester        | `opencode/nemotron-3-ultra-free`                 |
| delivery      | deployer      | `opencode/muse-spark-1.3-contributor-free`       |
| ceo-assistant | ceo-assistant | `opencode/big-pickle`                            |

These defaults are **free** — a fresh clone runs the whole pipeline with no API
key and no account. Swap any of them (per worker) from the panel's
**Models & Tools** tab, or in `opencode.jsonc`.

Built-in role agents live in `opencode.jsonc` (`architect`, `builder`,
`reviewer`, `deployer`, `tester`, `data-scientist`, `support`,
`ceo-assistant`) with system prompts, models and guardrails.

Each workspace is interactive in its own right:

```
workspaces/<id>/
├── AGENTS.md        # role/mission for sessions opened in this workspace
├── inbox/           # drop an app folder here → queued
├── apps/            # finished applications
└── runs/            # per-app logs + reports
```

Start a **web session scoped to a workspace** directly:

```bash
opencode --server http://127.0.0.1:4096 workspaces/engineering
```

## 3 · Models & gateways (free by default, one key if you want more)

Two gateways ship wired up. Both are editable from the panel
(**Models & Tools** tab) or from the CLI.

### OpenCode Zen — the default, has a free tier

OpenCode's own gateway. Refs look like `opencode/<model-id>`, and the free
models need **no key at all**:

```bash
opencode/big-pickle                              # all-rounder
opencode/muse-spark-1.3-contributor-free         # coding
opencode/nemotron-3-ultra-free                   # fast reasoning
opencode/space-bunny-free                        # free
opencode/mimo-v2.6-flash-free                    # free
opencode/ling-3.0-flash-fin-free                 # free
opencode/deepseek-v4-flash-free                  # free
```

Get a key at <https://opencode.ai/zen> (optional) → stored as `OPENCODE_API_KEY`.

### 9router — many providers behind one key (optional)

9router is configured as an OpenAI-compatible provider in `opencode.jsonc`:

```jsonc
"providers": {
  "9router": {
    "env": ["NINEROUTER_API_KEY"],
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {
      "baseURL": "https://api.9router.com/v1",   // or your 9router endpoint
      "apiKey": "{env:NINEROUTER_API_KEY}"
    },
    "models": { "oc/union-alpha": { "name": "oc/union-alpha" } }
  }
}
```

1. Put your key in `.env`: `NINEROUTER_API_KEY=sk-...` (the wizard asks for it).
2. **Import the live model catalog:**

   ```bash
   npm run models:sync          # Zen + 9router, whichever has a key
   npm run models:sync -- opencode
   npm run 9router:sync         # 9router only, also prints a providers block
   ```

   This queries `GET <baseURL>/models`, saves the list to
   `config/zen.models.json` / `config/9router.models.json`, and the panel picks
   it up immediately.
3. Reference models as `9router/<model>` and route tiers as
   `9router/<model>#low|medium|high` — e.g. `9router/oc/union-alpha#high`.

### The merged catalog

`GET /api/models` returns one catalog merged from Zen + 9router + your own refs,
free models first, retired ones flagged. Add any ref OpenCode can resolve —
including a local provider — straight from the panel:

```bash
curl -X POST localhost:8099/api/models/custom \
  -H "x-office-key: $KEY" -d '{"ref":"ollama/qwen3:8b"}'
```

Print it any time with `node lib/models.js`.

The wizard lets you assign any catalog model to any workspace. Any
OpenAI-compatible gateway works the same way — swap `baseURL` + `apiKey`.

## 4 · Building many apps from folders (the orchestrator)

- **Order a build:** create a folder with a `manifest.json` (see
  `inbox/README.md`) or use the scaffolder:

  ```bash
  npm run new-app -- engineering my-shop-api
  ```

- **What happens:** the orchestrator moves the folder into
  `apps/<division>/<name>/`, expands the short goal into a per-stage plan, and
  runs the full **Plan → Build → Review → Test → Deploy** pipeline — each stage
  picked up by an active worker for the job's division, evaluated (auto-checks
  + AI rubric score 0–100), retried with critique, or paused for a human.
- **Parallelism:** `settings.parallel` concurrent builds (default 2); each
  manifest can override `model` / `agent` / `prompt`.
- **Resilience:** a stage that fails the evaluation retries with the critique
  (default 2 attempts), then the build pauses as `needs-review` for a human to
  approve / reject / retry from the panel.

Status endpoints (the "detectable" part):

```
http://127.0.0.1:8099/panel      control center — staff CRUD, CEO office, new build, jobs, evaluation, models & tools
http://127.0.0.1:8099/           office cam — clean rooftop view, one desk per worker
http://127.0.0.1:8099/health     {"ok":true,"active":1,"workers":2,"queued":0,...}
http://127.0.0.1:8099/jobs       full job history
http://127.0.0.1:8099/workspaces theme + worker table
http://127.0.0.1:8099/api/ceo    CEO assistant status, notices, report archive
http://127.0.0.1:8099/api/events office event feed (what the bridges push to you)
http://127.0.0.1:8099/api/models merged model catalog (Zen + 9router + custom)
http://127.0.0.1:8099/api/tools  gateway/docs/office page links for the panel
```

The office cam (`public/office.html`, embedded in the panel) polls those
endpoints: a clean header with live status chips, one desk per worker with an
animated pixel worker, a build-activity ticker, and a state legend.

| Worker state | Meaning |
|---|---|
| `BUILDING` | a stage for this department is running (typing animation) |
| `QUEUED` | builds waiting for a free worker |
| `REVIEW` | a build is paused waiting for a human gate (needs-review) |
| `PAUSED` | a build is paused by request |
| `OUT OF TOKEN` | the last failure looks like a key/quota/balance error (`429`, `insufficient balance`, `401`…) — red pulsing badge |
| `ERROR` | last build failed for another reason |
| `DONE ✓` / `STOPPED` | last build finished / cancelled; occasional confetti |
| `IDLE` | resting between builds |

```bash
npm run status        # prints server + orchestrator + job status
npm run logs          # tails launcher/server/orchestrator/bridge logs
```

## 5 · Your CEO assistant (you are the CEO)

The office ships with a dedicated **CEO Assistant** — an employee whose only
job is to work *for you*, not on the build queue:

- **Reports** — the `CEO Office` tab in the panel asks the assistant for an
  executive report or a quick summary. It reads live office data (roster,
  every build, evaluations, gate decisions, failures) and answers for you.
  Reports are archived in `runs/ceo/`.
- **CEO ↔ worker communications** — broadcast a notice to everyone, one
  division, or one worker. It is appended to each recipient's `NOTICE.md` in
  their workspace, so the next build starts with your instruction on file.
- **Notifications** — build events (needs-review, failed, done, your notices)
  are published to the event feed and pushed to you over Discord / WhatsApp.
  `!report` in either chat returns the current office summary on the spot.
- Every agent in the office — assistants and workers alike — is prompted to
  treat the user as the CEO and report to them directly.

The assistant is a normal worker: edit its model, role or status in
`Office Staff`, or remove it (delete the `CEO Assistant` role too to stop it
being re-hired automatically).

```bash
# what the assistant sees right now
curl http://127.0.0.1:8099/api/ceo
# ask it for a report (needs the office key from config/server.password)
curl -X POST http://127.0.0.1:8099/api/ceo/report \
  -H "x-office-key: $(cat config/server.password)" -H 'content-type: application/json' \
  -d '{"kind":"summary","question":"what needs my attention?"}'
```

## 6 · Talk to the office from Discord / WhatsApp

### Discord
1. Create an app + bot at https://discord.com/developers/applications.
2. In the wizard, enable Discord and paste the **bot token**, then give the
   **channel id** for your notifications (right-click the channel → Copy
   Channel ID). Skip it to keep push notifications off.
3. Add the bot to a server and message it. In-chat commands:
   `!workspaces`, `!status`, `!report`, `!new [workspace]`, `!build <workspace> <text>`,
   `!ping`. Each channel gets its own persistent OpenCode session.

### WhatsApp
- **QR mode (recommended):** enable WhatsApp in the wizard and choose `qr`,
  then paste your own contact JID for notifications (e.g.
  `628123456789@s.whatsapp.net`) — or skip it to keep push off.
  On start, a **QR code prints to the terminal** — scan it with your phone
  (WhatsApp Web pairing). Sessions persist in `config/whatsapp-session/`.
  Needs Baileys once: `npm run deps:whatsapp`.
- **Token mode (Cloud API):** choose `token`, paste the access token + phone
  number ID. Outbound replies use the Graph API; inbound requires a public
  webhook endpoint on your VPS.

Both bridges map each chat to a persistent session bound to a workspace, so
conversations keep context, and "build me an app" works from chat. Both also
forward office alerts to you once a notification target is configured
(`DISCORD_NOTIFY_CHANNEL_ID` / `WHATSAPP_CEO_JID` override the wizard answers).

## 7 · Run 24/7 as OS services

Run the wizard once, then:

```bash
npm run install:service
# Linux  -> systemd: bigpickle-server, bigpickle-orchestrator, [+ bridges]
# Windows-> NSSM  : BigPickleServer, BigPickleOrchestrator,      [+ bridges]
```

- Env/keys are exported from `.env` to `/etc/bigpickle.env` (Linux) or to the
  NSSM service environment (Windows).
- Logs go to `runs/*.log` with rotation.
- Remove with `npm run uninstall:service`.

Manual notes:

```bash
systemctl status bigpickle-server            # Linux
nssm restart BigPickleServer                 # Windows (as admin)
```

## Configuration reference

| Where | What |
|---|---|
| `config/settings.json` | wizard output: port, parallel, divisions, roles, workers, integrations |
| `.env` | secrets: `NINEROUTER_API_KEY`, `DISCORD_BOT_TOKEN`, … |
| `runs/ceo/` | CEO assistant reports + notice history |
| `runs/events.json` | office event feed (last 400 events) the bridges push to you |
| `workspaces/<id>/NOTICE.md` | notices the CEO broadcast to that worker |
| `opencode.jsonc` | project config: 9router provider, role agents, permissions |
| `config/opencode.global.jsonc` | installed to `~/.config/opencode/opencode.jsonc` |
| `AGENTS.md` | office-wide instructions every session obeys |
| `templates/app/` | the manifest/README/AGENTS scaffold for new apps |

`npm run install:service -- --user alice` runs the Linux services as a
dedicated user (default `bigpickle` when installed as root).

## Security notes

- `opencode serve` binds to **127.0.0.1** only and requires Basic auth
  (username `opencode`, password in `config/server.password`). Use an SSH
  tunnel or a reverse proxy + `--cors` to expose it.
- `.env`, `config/settings.json`, `config/server.password` and bridge session
  stores are git-ignored — never commit them.
- Reviewer/deployer agents carry restrictive permissions in `opencode.jsonc`;
  escalate `permissions` as you see fit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Authentication failed ... config/server.password` | restart the server once so it writes a fresh password (`npm run logs -- server`) |
| WhatsApp: no QR | `npm run deps:whatsapp`, then re-run; to re-pair, delete `config/whatsapp-session/` |
| 9router `ConnectionRefused` | check `NINEROUTER_BASE_URL` / key; run `npm run 9router:sync` |
| Job stuck `running` | sessions time out after 6h and are interrupted; restart the orchestrator |
| Web UI not reachable from your machine | `ssh -L 4096:127.0.0.1:4096 user@vps` |
| No CEO reports in the panel | the office key (top-right) is missing/wrong, or the assistant's model is unreachable — a locally-assembled report is returned instead |
| No bridge notifications | set a notify target: `DISCORD_NOTIFY_CHANNEL_ID` / `WHATSAPP_CEO_JID` (or re-run the wizard) |

Big Pickle runs on any OS where Node + OpenCode run — Linux, macOS, Windows,
and any VPS sized for your parallel worker count.