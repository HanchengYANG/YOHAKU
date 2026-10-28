#!/usr/bin/env bash
# Usage: sudo bash scripts/pi-setup-system.sh APP_USER PROJECT_DIR HTTPS_ORIGIN
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 3 ]] || {
  echo 'Usage: sudo bash scripts/pi-setup-system.sh APP_USER PROJECT_DIR HTTPS_ORIGIN' >&2; exit 1;
}
app_user=$1
root=$2
origin=$3
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]*$ && "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$origin" =~ ^https://[a-zA-Z0-9.-]+$ ]] || {
  echo 'Use an absolute project path without spaces and an HTTPS DNS name or IPv4 address (default port 443).' >&2; exit 1;
}
[[ "$app_user" != root ]] || { echo 'Use an unprivileged application user.' >&2; exit 1; }
app_home=$(getent passwd "$app_user" | cut -d: -f6)
app_group=$(id -gn "$app_user")
[[ "$app_home" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Unsupported home directory.' >&2; exit 1; }
version=$(tr -d '[:space:]' < "$root/.nvmrc")
case $(uname -m) in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
node_bin="$app_home/.local/share/yohaku/node-v${version}-linux-${arch}/bin"
[[ -f "$root/dist/index.html" && -x "$node_bin/node" ]] || {
  echo 'Run scripts/pi-install-runtime.sh as the application user first.' >&2; exit 1;
}
host=${origin#https://}
if [[ "$host" =~ ^[0-9.]+$ ]]; then san="IP:$host"; else san="DNS:$host"; fi
apt-get update
apt-get install -y nginx openssl
install -d -m 700 /etc/nginx/yohaku
if [[ ! -e /etc/nginx/yohaku/tls.key && ! -e /etc/nginx/yohaku/tls.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -keyout /etc/nginx/yohaku/tls.key -out /etc/nginx/yohaku/tls.crt \
    -subj "/CN=$host" -addext "subjectAltName=$san"
fi
chmod 600 /etc/nginx/yohaku/tls.key
# Render host-specific files outside the Git checkout.
render() {
  sed -e "s|@APP_USER@|$app_user|g" -e "s|@APP_GROUP@|$app_group|g" \
    -e "s|@APP_ROOT@|$root|g" -e "s|@APP_HOME@|$app_home|g" \
    -e "s|@NODE_BIN@|$node_bin|g" -e "s|@PUBLIC_ORIGIN@|$origin|g" \
    -e "s|@SITE_HOST@|$host|g" "$1"
}
render "$root/deploy/nginx.conf" > /etc/nginx/sites-available/yohaku
chmod 644 /etc/nginx/sites-available/yohaku
ln -sfn /etc/nginx/sites-available/yohaku /etc/nginx/sites-enabled/yohaku
if [[ -L /etc/nginx/sites-enabled/default && $(readlink /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
nginx -t
render "$root/deploy/yohaku.service" > /etc/systemd/system/yohaku.service
chmod 644 /etc/systemd/system/yohaku.service
systemctl daemon-reload
systemctl enable yohaku.service nginx.service
systemctl restart yohaku.service
systemctl start nginx.service
systemctl reload nginx.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 http://127.0.0.1:4317/api/health
printf '\nHTTPS: %s (self-signed certificate)\n' "$origin"
