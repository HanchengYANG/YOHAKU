#!/usr/bin/env bash
# Shared configuration loader and template renderer; source from deployment tools.
deploy_error() { echo "Deployment configuration: $*" >&2; exit 1; }

load_deploy_config() {
  local repo config origin host san
  local -a origins hosts=() sans=()
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  config=${1:-$repo/.env.deploy}
  [[ -f "$config" ]] || deploy_error 'Copy deploy/config.env.example to a local instance and select it with .env.deploy or a script argument.'
  DEPLOY_CONFIG=$(realpath -e "$config")
  if git -c safe.directory="$repo" -C "$repo" ls-files --error-unmatch "$DEPLOY_CONFIG" >/dev/null 2>&1; then
    deploy_error 'Use a private untracked instance, not the committed example.'
  fi
  APP_USER= APP_DIR= PUBLIC_ORIGIN= PUBLIC_ORIGINS= DEPLOY_KEY= DATA_DIR=
  TLS_MODE=self-signed TLS_CA_CERT= TLS_CA_KEY= TLS_CERT_DAYS=365 TLS_CA_DAYS=3650
  GIT_REMOTE=origin GIT_BRANCH=main PORT=4317 HTTPS_PORT=443
  TLS_CERT=/etc/nginx/yohaku/tls.crt TLS_KEY=/etc/nginx/yohaku/tls.key
  # An administrator explicitly selects this local file; it is trusted shell input.
  source "$DEPLOY_CONFIG"
  [[ "$TLS_CERT" != "$TLS_KEY" ]] || deploy_error 'Use separate files for the server certificate and key.'
  case "$TLS_MODE" in
    self-signed) TLS_CA_CERT=${TLS_CA_CERT:-$TLS_CERT}
      [[ "$TLS_CA_CERT" == "$TLS_CERT" ]] || deploy_error 'Self-signed mode uses TLS_CERT as its trust anchor.' ;;
    local-ca)
      [[ -n "$TLS_CA_CERT" && -n "$TLS_CA_KEY" ]] || deploy_error 'Local CA mode requires explicit TLS_CA_CERT and TLS_CA_KEY paths.'
      [[ "$TLS_CA_CERT" != "$TLS_CA_KEY" && "$TLS_CERT" != "$TLS_CA_CERT" && "$TLS_CERT" != "$TLS_CA_KEY" && "$TLS_KEY" != "$TLS_CA_CERT" && "$TLS_KEY" != "$TLS_CA_KEY" ]] || deploy_error 'Use separate files for the CA and server certificate/key.' ;;
    existing) ;;
    *) deploy_error 'TLS_MODE must be self-signed, local-ca, or existing.' ;;
  esac
  [[ "$TLS_CERT_DAYS" =~ ^[1-9][0-9]{0,3}$ && "$TLS_CA_DAYS" =~ ^[1-9][0-9]{0,4}$ ]] || deploy_error 'Certificate lifetimes must be positive days.'
  [[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$APP_USER" != root ]] || deploy_error 'APP_USER must be an existing non-root user.'
  APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6) || deploy_error 'APP_USER does not exist.'
  APP_GROUP=$(id -gn "$APP_USER") || deploy_error 'APP_USER does not exist.'
  [[ "$APP_DIR" =~ ^/[a-zA-Z0-9_./-]+$ && -f "$APP_DIR/.nvmrc" ]] || deploy_error 'APP_DIR must be an existing project path without spaces.'
  APP_DIR=$(realpath -e "$APP_DIR")
  DATA_DIR=${DATA_DIR:-$APP_DIR/data}
  for config in "$APP_HOME" "$DATA_DIR" "$TLS_CERT" "$TLS_KEY" "$DEPLOY_CONFIG" ${TLS_CA_CERT:+"$TLS_CA_CERT"} ${TLS_CA_KEY:+"$TLS_CA_KEY"}; do
    [[ "$config" =~ ^/[a-zA-Z0-9_./-]+$ ]] || deploy_error 'Use absolute paths without spaces or shell characters.'
  done
  [[ -z "$DEPLOY_KEY" || "$DEPLOY_KEY" =~ ^/[a-zA-Z0-9_./-]+$ ]] || deploy_error 'DEPLOY_KEY must be an absolute path without spaces.'
  [[ "$GIT_REMOTE" =~ ^[a-zA-Z0-9_.-]+$ ]] || deploy_error 'GIT_REMOTE must name a configured Git remote.'
  git check-ref-format --branch "$GIT_BRANCH" >/dev/null 2>&1 || deploy_error 'GIT_BRANCH is invalid.'
  [[ "$PORT" =~ ^[0-9]{1,5}$ && "$HTTPS_PORT" =~ ^[0-9]{1,5}$ ]] || deploy_error 'Ports must be integers.'
  [[ "$PORT" != 0* && "$HTTPS_PORT" != 0* ]] || deploy_error 'Ports must not have leading zeroes.'
  (( PORT >= 1024 && PORT <= 65535 && HTTPS_PORT >= 1 && HTTPS_PORT <= 65535 && PORT != HTTPS_PORT )) || deploy_error 'Use an app port from 1024 to 65535 and a different HTTPS port from 1 to 65535.'
  [[ -n "$PUBLIC_ORIGIN" ]] || deploy_error 'PUBLIC_ORIGIN is required.'
  IFS=, read -r -a origins <<< "$PUBLIC_ORIGIN${PUBLIC_ORIGINS:+,$PUBLIC_ORIGINS}"
  for origin in "${origins[@]}"; do
    [[ "$origin" =~ ^https://([a-zA-Z0-9.-]+)(:([0-9]{1,5}))?$ ]] || deploy_error 'Origins must be HTTPS DNS names or IPv4 addresses, optionally with a port, without paths.'
    host=${BASH_REMATCH[1]}
    if [[ -n "${BASH_REMATCH[3]:-}" ]]; then
      local origin_port=${BASH_REMATCH[3]}
      [[ "$origin_port" != 0* ]] && (( origin_port >= 1 && origin_port <= 65535 )) || deploy_error 'Origin port is invalid.'
    fi
    if [[ ! " ${hosts[*]} " == *" $host "* ]]; then
      hosts+=("$host")
      if [[ "$host" =~ ^[0-9.]+$ ]]; then san="IP:$host"; else san="DNS:$host"; fi
      sans+=("$san")
    fi
  done
  SITE_HOSTS="${hosts[*]}"
  CERT_HOST=${hosts[0]}
  CERT_SAN=$(IFS=,; echo "${sans[*]}")
  NODE_VERSION=$(tr -d '[:space:]' < "$APP_DIR/.nvmrc")
  [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || deploy_error '.nvmrc must contain an exact Node version.'
  case $(uname -m) in aarch64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; *) deploy_error 'Unsupported architecture.' ;; esac
  NODE_ROOT="$APP_HOME/.local/share/yohaku/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  NODE_BIN="$NODE_ROOT/bin"
}

render_deploy_template() {
  sed -e "s|@APP_USER@|$APP_USER|g" -e "s|@APP_GROUP@|$APP_GROUP|g" \
    -e "s|@APP_ROOT@|$APP_DIR|g" -e "s|@APP_HOME@|$APP_HOME|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@PUBLIC_ORIGIN@|$PUBLIC_ORIGIN|g" \
    -e "s|@PUBLIC_ORIGINS@|$PUBLIC_ORIGINS|g" -e "s|@SITE_HOSTS@|$SITE_HOSTS|g" \
    -e "s|@PORT@|$PORT|g" -e "s|@HTTPS_PORT@|$HTTPS_PORT|g" \
    -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@TLS_CERT@|$TLS_CERT|g" \
    -e "s|@TLS_KEY@|$TLS_KEY|g" "$1"
}
