# BUILD_REPORT.md — Big Pickle · Digital Workers publish build

**Build** · `npm run build:publish` → `build/bigpickle-vps/` + `build/bigpickle-vps.zip`
**Version** · bigpickle-vps-builder v2.0.0
**Built** · 2026-09-26
**Scope** · main workspace: `opencodeunlimitedvps`

## What shipped

| Area | Status |
|---|---|
| **Digital Workers control panel** (`/panel`) | ✅ one-page control center: **Roof Cam · Office Staff · CEO Office · New Build · Jobs · Evaluation · Models & Tools** tabs, office-key auth, live polling |
| **Model catalog & gateways** (`lib/models.js`) | ✅ one merged catalog — OpenCode Zen (**81 models, 11 free**) + 9router + any custom ref; free-first ordering, retired models flagged; **no API key needed to run the office** |
| **Gateway customization from the panel** | ✅ base URL + API key per gateway (9router, OpenCode Zen) saved to `.env` / `config/settings.json`; secrets only ever returned masked |
| **Live model sync** | ✅ `POST /api/models/sync` + `npm run models:sync` — pulls `GET <gateway>/models`; Zen is public (no key), 9router skips cleanly with a clear message; the same list lands in the worker/job model pickers |
| **Add any model by hand** | ✅ `POST/DELETE /api/models/custom` and a field in the panel — local providers (`ollama/…`), any gateway path, anything OpenCode can resolve |
| **Tool pages hub** (`GET /api/tools`) | ✅ 11 gateway/docs pages (9router console + docs, Zen, Zen live model list, provider/model/agent/config/permission/skill references, OpenCode home) and 8 office endpoints, rendered as one-click cards in the panel |
| **Office Staff CRUD made obvious** | ✅ management toolbar (Hire worker / New role / New division) + labeled per-row `pause · resume · edit · delete` on workers, roles and divisions |
| **CEO Assistant** (`ceo-assistant` role + worker) | ✅ auto-hired with the office; agent, model and variant editable like any worker |
| **CEO reports** (`POST /api/ceo/report`) | ✅ assistant reads live office data (roster, builds, evaluations, gates, failures) and answers; archived in `runs/ceo/`; locally-assembled fallback when the model is unreachable |
| **CEO ↔ worker comms** (`POST /api/ceo/notice`) | ✅ broadcast to everyone / one division / one worker; appended to each recipient's `NOTICE.md`; history in `GET /api/ceo` |
| **Office event feed + bridge notifications** | ✅ `/api/events`; Discord + WhatsApp bridges forward needs-review / failed / done / CEO notices to the configured target, and answer `!report` |
| **Everyone reports to the CEO** | ✅ all agents in `opencode.jsonc`, every pipeline stage prompt, the app scaffold and the wizard copy address the user as the CEO |
| **Pipeline Plan→Build→Review→Test→Deploy** (`lib/pipeline.js`) | ✅ short goal → per-stage prompts, evaluated at every stage, retry-with-critique, needs-review pause gate |
| **Evaluation gates** | ✅ auto-checks (syntax, artifact, secret scan) + AI rubric score 0–100 vs threshold (default 70), up to 2 critique retries, then human approve/reject/retry |
| **Workers / Roles / Divisions model** (`lib/model.js`) | ✅ fully custom roles (SDLC stages + OpenCode agent + scorer flag), divisions, worker roster; fallback chains; `tester` + `ceo-assistant` roles ship by default |
| **CRUD API** | ✅ `/api/workers /roles /divisions /settings /evaluations /models /ceo /events /builds/:id` — mutations require `x-office-key`, live-reloaded, persisted to `config/settings.json` |
| **New Build questionnaire** | ✅ submit a one-line app goal → orchestrator picks the division's workers per stage and runs the whole pipeline |
| **Local deploy + preview** | ✅ clean package + `DEPLOY.md` + auto-start static preview (port pool 8100+, avoiding 8099); `/api/previews` |
| Office cam (`/office`, embedded in the panel) | ✅ rebuilt clean: HTML header with live status chips, one desk per worker, build-activity ticker, state legend, light vignette; maps **REVIEW / PAUSED / STOPPED** too |
| Launcher + wizard (`index.js` / `lib/wizard.js` × `lib/prompt.js`) | ✅ v2 questionnaire: gateway (**9router / OpenCode Zen / direct / existing**), divisions + roles + workers incl. tester + CEO Assistant, bridge notification targets; numeric `workers` migrates to `parallel` |
| 8 role agents incl. **ceo-assistant/tester/data-scientist/support** | ✅ `opencode.jsonc` — all pinned to **free** Zen models out of the box; the 9router provider block stays available but optional |
| Health API (`/health /jobs /workspaces`) | ✅ cam + bridges compatible (workers = parallel builds) |
| Discord + WhatsApp bridges, OS services, status scripts | ✅ unchanged, verified against new health API |

## QA performed on this build

- `node --check` on every shipped `.js` file — all pass.
- Wizard end-to-end (piped) with bad answers → re-ask warnings; final settings correct; demo config restored afterwards.
- Pipeline dry-run E2E (no provider) **green path**: plan→build→review→test→deploy all PASS, job `done`, preview server serving files 200.
- Pipeline dry-run E2E **gate path**: approve→done, reject→failed, pause→resume→needs-review→cancel→cancelled.
- Phase 3 API E2E: division/role/worker CRUD (add · update · pause/resume · delete · dup/bad-input rejection), settings PUT live-reload, 5-stage build with 5 evaluations, `/api/builds/:id`, `/api/evaluations`, `/api/models`, `/panel` + `/` both 200.
- Office cam inline JS `node --check` clean; status mapping verified.
- CEO surface dry-run E2E: `GET /api/ceo` (assistant auto-hired, agent + model resolved), notices to all / one division / one worker (8 · 8 · 1 recipients, each written to `NOTICE.md`), empty notice rejected 400, `POST /api/ceo/report` returns a full executive report, `GET /api/events` lists the published notice events, `/panel` and `/office` both 200. Test artifacts removed afterwards.
- Model catalog E2E: `GET /api/models` returns 81 models / 11 free / gateways masked; **live** `POST /api/models/sync` against `https://opencode.ai/zen/v1/models` returns the same 81 (bundled snapshot matches the endpoint exactly); `9router` sync without a key fails with a clear message, not a crash; custom model add → appears in the catalog → delete → gone; malformed ref rejected 400; `PUT /api/gateways` persists and reports masked state; every mutating route 401s without `x-office-key`. `node lib/models.js` and the panel's inline JS both pass `node --check`.

## Excluded from the build (secrets / user data)

`.env`, `config/settings.json`, `config/server.password`, `config/bridge-sessions.json`,
`config/9router.models.json`, `config/zen.models.json`, `config/custom.models.json`,
`config/whatsapp-session/`, `runs/`, `workspaces/`, `apps/`,
`node_modules/`, `build/`, `.git/`, tools.

## End-user first-run

1. `node index.js --wizard` — answer the questionnaire (gateway, divisions, roles, workers, CEO Assistant, bridge notification targets, tokens)
2. `node index.js` — office up; `http://127.0.0.1:8099/panel` (control center) · `http://127.0.0.1:8099/` (office cam)
3. Drop a goal in **New Build** → workers run Plan→Build→Review→Test→Deploy with evaluation gates
4. **CEO Office** → ask the assistant for a report, broadcast a notice to staff
5. **Models & Tools** → sync a gateway, add a model, or jump to a tool page
6. `npm run install:service` — 24/7