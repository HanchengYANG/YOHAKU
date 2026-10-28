#!/usr/bin/env bash
# Usage: bash scripts/pi-install-runtime.sh [CONFIG_FILE]
set -euo pipefail
[[ $(id -u) -ne 0 && $# -le 1 ]] || { echo 'Run as the application user with an optional config path.' >&2; exit 1; }
source "$(dirname "$0")/pi-config.sh"
load_deploy_config "${1:-}"
[[ $(id -un) == "$APP_USER" ]] || deploy_error 'Run as the configured APP_USER.'
if [[ ! -x "$NODE_BIN/node" ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  archive="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  curl --fail --show-error --location "$base/$archive" -o "$work/$archive"
  curl --fail --show-error --location "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work"; awk -v file="$archive" '$2 == file' SHASUMS256.txt > checksum; test -s checksum; sha256sum -c checksum)
  mkdir -p "$(dirname "$NODE_ROOT")"
  tar -xJf "$work/$archive" -C "$(dirname "$NODE_ROOT")"
fi
export PATH="$NODE_BIN:$PATH"
node --version
npm install --global --prefix "$APP_HOME/.local/share/yohaku/codex" @openai/codex@0.160.1
"$APP_HOME/.local/share/yohaku/codex/bin/codex" --version
cd "$APP_DIR"
npm ci
npm run build
