# bootstrap.ps1 — one-shot server preparation for Windows VPS.
#   powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
# Installs Node LTS (winget), OpenCode CLI (npm), project deps, office folders.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host ''
Write-Host '==> Big Pickle bootstrap - Node.js + OpenCode + deps' -ForegroundColor Cyan

# 1) Node.js >= 18
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Installing Node.js LTS via winget...'
  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  # winget installs to Program Files; refresh PATH for this session
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
node --version

# 2) OpenCode CLI (npm package; postinstall grabs the native binary)
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing OpenCode via npm...'
  npm install -g @opencode/cli
}
opencode --version

# 3) project deps (Baileys for WhatsApp QR is optional)
npm install --no-audit --no-fund

# 4) office dirs + global config
$dirs = @('inbox','apps','runs','workspaces','config','skills')
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$ocGlobal = Join-Path $HOME '.config\opencode\opencode.jsonc'
if (-not (Test-Path $ocGlobal)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $ocGlobal) | Out-Null
  Copy-Item 'config\opencode.global.jsonc' $ocGlobal
  Write-Host "global opencode config installed at $ocGlobal"
}

Write-Host ''
Write-Host 'DONE. Next:' -ForegroundColor Green
Write-Host '   1) node index.js --wizard    # questionnaire: port, 9router key, workspaces, Discord/WhatsApp'
Write-Host '   2) node index.js             # open the office (Ctrl+C stops)'
Write-Host "   3) npm run install:service   # 24/7: NSSM services (auto-downloaded), survives reboot"