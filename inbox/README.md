# inbox

Drop a **folder** here (ideally created with `npm run new-app -- <workspace> <name>`)
and the orchestrator will:

1. pick it up within a few seconds,
2. move it into `../workspaces/<workspace>/apps/<name>/`,
3. open a session for that workspace's role + model on the always-on server,
4. build it, writing `BUILD_REPORT.md`.

A folder becomes a job when it contains a `manifest.json`:

```jsonc
{
  "name": "my-app",            // app folder name
  "description": "what it does",
  "stack": "node, react, ...",
  "model": "9router/...",      // optional override of the workspace model
  "agent": "builder",          // optional override of the workspace role
  "prompt": "build it"
}
```

Or use the wizard-friendly route:

```bash
npm run new-app -- engineering my-api     # Linux/macOS
npm run new-app -- engineering my-api     # Windows (same)
```

Workspace ids (from the wizard): run `node scripts/status.js` or check
`config/settings.json` → `workspaces`.