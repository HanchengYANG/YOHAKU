#!/usr/bin/env bash
# Usage: bash scripts/pi-deploy.sh [--test] [CONFIG_FILE]
set -euo pipefail
deploy_usage() { echo 'Usage: bash scripts/pi-deploy.sh [--test] [CONFIG_FILE]' >&2; }
deploy_run_tests=false
deploy_config_file=
deploy_config_supplied=false
for argument in "$@"; do
  case "$argument" in
    --test) deploy_run_tests=true ;;
    -*) deploy_usage; exit 1 ;;
    *)
      if "$deploy_config_supplied"; then deploy_usage; exit 1; fi
      deploy_config_file=$argument
      deploy_config_supplied=true
      ;;
  esac
done
[[ $(id -u) -ne 0 ]] || { echo 'Run as the application user.' >&2; exit 1; }
source "$(dirname "$0")/pi-config.sh"
load_deploy_config "$deploy_config_file"
[[ $(id -un) == "$APP_USER" ]] || deploy_error 'Run as the configured APP_USER.'
cd "$APP_DIR"
exec 9>"$APP_HOME/.yohaku-deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
[[ -z $(git status --porcelain) && $(git branch --show-current) == "$GIT_BRANCH" ]] || {
  echo 'Deployment requires a clean checkout of the configured branch.' >&2; exit 1;
}
if [[ -n "$DEPLOY_KEY" ]]; then
  [[ -r "$DEPLOY_KEY" ]] || deploy_error 'DEPLOY_KEY is not readable.'
  export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi
sudo -v
git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH"
load_deploy_config "$DEPLOY_CONFIG"
[[ -x "$NODE_BIN/node" ]] || { echo 'Run scripts/pi-install-runtime.sh first.' >&2; exit 1; }
export PATH="$NODE_BIN:$PATH"
# Validate or create only the configured certificate pairs before downtime.
sudo bash "$APP_DIR/scripts/pi-certificates.sh" "$DEPLOY_CONFIG"
sudo systemctl stop yohaku.service
trap 'echo "Deployment failed. Inspect journalctl -u yohaku; service may be stopped. Check the data backup before recovering." >&2' ERR
if [[ -d "$DATA_DIR" ]]; then
  backup="$APP_HOME/.local/state/yohaku/backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p -m 700 "$backup"
  cp -a "$DATA_DIR" "$backup/data"
  echo "Data backup: $backup/data"
fi
npm ci
if "$deploy_run_tests"; then
  # Serialize crypto-heavy account fixtures on small servers.
  YOHAKU_TEST_HTTP_TIMEOUT_MS="$DEPLOY_TEST_HTTP_TIMEOUT_MS" node --test --test-concurrency=1 tests/*.test.mjs
fi
npm run build
sudo bash "$APP_DIR/scripts/pi-setup-system.sh" "$DEPLOY_CONFIG"
if [[ -n "$TLS_CA_CERT" ]]; then
  verify_certificate=$(mktemp)
  trap 'rm -- "$verify_certificate"' EXIT
  openssl x509 -inform DER -in /var/lib/yohaku/certificates/yohaku.crt -out "$verify_certificate"
  curl --cacert "$verify_certificate" --fail --silent --show-error "$PUBLIC_ORIGIN/api/health"
else
  curl --fail --silent --show-error "$PUBLIC_ORIGIN/api/health"
fi
printf '\nDeployed commit: '
git rev-parse --short HEAD
