#!/usr/bin/env bash
# Usage: sudo bash scripts/pi-setup-system.sh [CONFIG_FILE]
set -euo pipefail
umask 077
[[ $(id -u) -eq 0 && $# -le 1 ]] || { echo 'Run with sudo and an optional config path.' >&2; exit 1; }
source "$(dirname "$0")/pi-config.sh"
load_deploy_config "${1:-}"
[[ -f "$APP_DIR/dist/index.html" && -x "$NODE_BIN/node" ]] || {
  echo 'Run scripts/pi-install-runtime.sh as the application user first.' >&2; exit 1;
}
if ! command -v nginx >/dev/null || ! command -v openssl >/dev/null; then
  apt-get update
  apt-get install -y nginx openssl
fi
for directory in "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")"; do
  if [[ ! -d "$directory" ]]; then install -d -m 700 "$directory"; fi
done
if [[ ! -e "$TLS_KEY" && ! -e "$TLS_CERT" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -keyout "$TLS_KEY" -out "$TLS_CERT" \
    -subj "/CN=$CERT_HOST" -addext "subjectAltName=$CERT_SAN"
fi
[[ -f "$TLS_KEY" && -f "$TLS_CERT" ]] || deploy_error 'Both TLS_CERT and TLS_KEY must exist.'
# Render private values outside Git. The runtime receives only application values,
# not deployment SSH settings or the whole shell configuration.
install -d -m 700 /etc/yohaku
render_deploy_template "$APP_DIR/deploy/runtime.env" > /etc/yohaku/runtime.env
chmod 600 /etc/yohaku/runtime.env
render_deploy_template "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/yohaku
chmod 644 /etc/nginx/sites-available/yohaku
ln -sfn /etc/nginx/sites-available/yohaku /etc/nginx/sites-enabled/yohaku
if [[ -L /etc/nginx/sites-enabled/default && $(readlink /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
nginx -t
render_deploy_template "$APP_DIR/deploy/yohaku.service" > /etc/systemd/system/yohaku.service
chmod 644 /etc/systemd/system/yohaku.service
systemctl daemon-reload
systemctl enable yohaku.service nginx.service
systemctl restart yohaku.service
systemctl start nginx.service
systemctl reload nginx.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 "http://127.0.0.1:$PORT/api/health"
printf '\nHTTPS: %s\n' "$PUBLIC_ORIGIN"
