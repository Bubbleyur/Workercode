#!/usr/bin/env bash
# bootstrap.sh — one-shot server preparation for Linux/macOS VPS.
#   curl -fsSL https://opencode.ai/v2/install | bash   (opencode)
#   apt/dnf package manager for Node, or use nvm.
# Run:  bash scripts/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

info "Big Pickle bootstrap — Node.js + OpenCode + deps"

# 1) Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  info "Node.js not found — installing LTS via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm alias default lts/* >/dev/null
else
  node --version
fi

# 2) OpenCode
if ! command -v opencode >/dev/null 2>&1; then
  info "Installing OpenCode (curl installer)"
  curl -fsSL https://opencode.ai/v2/install | bash
  export PATH="$HOME/.opencode/bin:$PATH"
fi
opencode --version

# 3) project deps (Baileys for WhatsApp QR optional)
info "Installing npm dependencies"
npm install --no-audit --no-fund || true

# 4) office dirs + global config
mkdir -p inbox apps runs workspaces config skills
if [ ! -f "$HOME/.config/opencode/opencode.jsonc" ]; then
  mkdir -p "$HOME/.config/opencode"
  cp config/opencode.global.jsonc "$HOME/.config/opencode/opencode.jsonc"
  info "global opencode config installed at ~/.config/opencode/opencode.jsonc"
fi

chmod +x index.sh scripts/*.sh 2>/dev/null || true

info "DONE. Next:"
echo "   1) node index.js --wizard     # questionnaire: port, 9router key, workspaces, Discord/WhatsApp"
echo "   2) node index.js              # open the office (Ctrl+C stops)"
echo "   3) npm run install:service    # 24/7: systemd services, survives reboot"