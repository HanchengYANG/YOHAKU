#!/usr/bin/env bash
# Run as the application user. Requires sudo for service management.
set -euo pipefail
[[ $(id -u) -ne 0 ]] || { echo 'Run as the application user.' >&2; exit 1; }
cd "$(dirname "$0")/.."
# This optional shell configuration is local-only and ignored by Git.
if [[ -f .env.deploy ]]; then source .env.deploy; fi
: "${PUBLIC_ORIGIN:?Set PUBLIC_ORIGIN in the environment or .env.deploy.}"
case $(uname -m) in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
exec 9>"$HOME/.yohaku-deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
[[ -z $(git status --porcelain) && $(git branch --show-current) == main ]] || {
  echo 'Deployment requires a clean main branch. Commit or review local changes first.' >&2; exit 1;
}
sudo -v
git pull --ff-only origin main
export PATH="$HOME/.local/share/yohaku/node-v$(tr -d '[:space:]' < .nvmrc)-linux-${arch}/bin:$PATH"
[[ -x $(command -v node) && $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || {
  echo 'Run scripts/pi-install-runtime.sh first.' >&2; exit 1;
}
sudo systemctl stop yohaku.service
trap 'echo "Deployment failed. Inspect journalctl -u yohaku; service may be stopped. Backups are in ~/.local/state/yohaku/backups/." >&2' ERR
if [[ -d data ]]; then
  backup="$HOME/.local/state/yohaku/backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p -m 700 "$backup"
  cp -a data "$backup/"
  echo "Data backup: $backup/data"
fi
npm ci
# Serialize tests to avoid crypto-heavy account fixtures competing on the Pi.
node --test --test-concurrency=1 tests/*.test.mjs
npm run build
sudo systemctl start yohaku.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 http://127.0.0.1:4317/api/health
curl --insecure --fail --silent --show-error "$PUBLIC_ORIGIN/api/health"
printf '\nDeployed commit: '
git rev-parse --short HEAD
