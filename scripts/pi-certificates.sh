#!/usr/bin/env bash
# Usage: sudo bash scripts/pi-certificates.sh [--renew] [CONFIG_FILE]
# Names come only from PUBLIC_ORIGIN/PUBLIC_ORIGINS in the selected instance.

tls_pair_exists() {
  if [[ -e "$1" || -e "$2" ]]; then
    [[ -f "$1" && -f "$2" ]] || deploy_error 'Both certificate and private key must exist, or both must be absent.'
    return 0
  fi
  return 1
}

tls_check_pair() {
  local certificate_public key_public
  openssl x509 -in "$1" -checkend 0 -noout >/dev/null || deploy_error 'Certificate is invalid or expired.'
  certificate_public=$(openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
  key_public=$(openssl pkey -in "$2" -passin pass: -pubout -outform DER | openssl dgst -sha256)
  [[ "$certificate_public" == "$key_public" ]] || deploy_error 'Certificate and private key do not match.'
}

tls_check_ca() {
  openssl x509 -in "$1" -noout -ext basicConstraints | grep -q 'CA:TRUE' || \
    deploy_error 'TLS_CA_CERT must be a CA certificate that phones can trust.'
  openssl x509 -in "$1" -checkend 0 -noout >/dev/null || deploy_error 'CA certificate is invalid or expired.'
}

configure_certificates() (
  set -euo pipefail
  umask 077
  local renew=${1:-false} work host directory
  command -v openssl >/dev/null || deploy_error 'openssl is required.'
  if [[ "$TLS_MODE" == existing ]]; then
    [[ "$renew" == false ]] || deploy_error 'Existing mode never generates certificates; replace the configured files explicitly.'
    tls_pair_exists "$TLS_CERT" "$TLS_KEY" || deploy_error 'Existing mode requires TLS_CERT and TLS_KEY.'
  else
    for directory in "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")" ${TLS_CA_CERT:+"$(dirname "$TLS_CA_CERT")"} ${TLS_CA_KEY:+"$(dirname "$TLS_CA_KEY")"}; do
      [[ -d "$directory" ]] || install -d -m 700 "$directory"
    done
    work=$(mktemp -d)
    trap 'rm -r -- "$work"' EXIT
    if [[ "$TLS_MODE" == local-ca ]]; then
      if ! tls_pair_exists "$TLS_CA_CERT" "$TLS_CA_KEY"; then
        if tls_pair_exists "$TLS_CERT" "$TLS_KEY"; then
          deploy_error 'CA is missing for an existing server; refusing to replace its trust anchor.'
        fi
        openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days "$TLS_CA_DAYS" \
          -keyout "$work/ca.key" -out "$work/ca.crt" -subj "/CN=$CERT_HOST YOHAKU CA" \
          -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
          -addext 'keyUsage=critical,keyCertSign,cRLSign'
        install -m 600 "$work/ca.key" "$TLS_CA_KEY"
        install -m 644 "$work/ca.crt" "$TLS_CA_CERT"
      fi
      tls_check_ca "$TLS_CA_CERT"
      tls_check_pair "$TLS_CA_CERT" "$TLS_CA_KEY"
    fi
    if ! tls_pair_exists "$TLS_CERT" "$TLS_KEY" || [[ "$renew" == true ]]; then
      if [[ "$TLS_MODE" == local-ca ]]; then
        openssl req -new -newkey rsa:3072 -nodes -keyout "$work/server.key" \
          -out "$work/server.csr" -subj "/CN=$CERT_HOST"
        printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
          'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' \
          "subjectAltName=$CERT_SAN" 'subjectKeyIdentifier=hash' \
          'authorityKeyIdentifier=keyid,issuer' > "$work/extensions"
        openssl x509 -req -in "$work/server.csr" -CA "$TLS_CA_CERT" -CAkey "$TLS_CA_KEY" \
          -set_serial "0x$(openssl rand -hex 16)" -days "$TLS_CERT_DAYS" -sha256 \
          -extfile "$work/extensions" -out "$work/server.crt"
        cat "$work/server.crt" "$TLS_CA_CERT" > "$work/chain.crt"
      else
        openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days "$TLS_CERT_DAYS" \
          -keyout "$work/server.key" -out "$work/chain.crt" -subj "/CN=$CERT_HOST" \
          -addext "subjectAltName=$CERT_SAN" -addext 'basicConstraints=critical,CA:TRUE' \
          -addext 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign' \
          -addext 'extendedKeyUsage=serverAuth'
      fi
      if [[ -f "$TLS_CERT" ]]; then
        local backup
        backup=$(mktemp -d "$(dirname "$TLS_CERT")/backup.XXXXXX")
        install -m 644 "$TLS_CERT" "$backup/server.crt"
        install -m 600 "$TLS_KEY" "$backup/server.key"
        echo "Previous TLS pair: $backup"
      fi
      install -m 600 "$work/server.key" "$TLS_KEY"
      install -m 644 "$work/chain.crt" "$TLS_CERT"
    fi
  fi
  tls_check_pair "$TLS_CERT" "$TLS_KEY"
  for host in $SITE_HOSTS; do
    if [[ "$host" =~ ^[0-9.]+$ ]]; then
      openssl verify -purpose sslserver -partial_chain -trusted "$TLS_CERT" \
        -verify_ip "$host" "$TLS_CERT" >/dev/null 2>&1
    else
      openssl verify -purpose sslserver -partial_chain -trusted "$TLS_CERT" \
        -verify_hostname "$host" "$TLS_CERT" >/dev/null 2>&1
    fi || deploy_error 'Certificate does not cover the configured origins. Renew it explicitly with pi-certificates.sh --renew, or provide matching existing files.'
  done
  if [[ -n "$TLS_CA_CERT" ]]; then
    tls_check_ca "$TLS_CA_CERT"
    openssl verify -purpose sslserver -CAfile "$TLS_CA_CERT" -untrusted "$TLS_CERT" "$TLS_CERT"
  fi
)

export_public_certificate() (
  set -euo pipefail
  local destination=$1 temporary
  if [[ -z "$TLS_CA_CERT" ]]; then
    [[ ! -e "$destination" ]] || rm -- "$destination"
    return
  fi
  tls_check_ca "$TLS_CA_CERT"
  install -d -m 755 "$(dirname "$destination")"
  temporary=$(mktemp "${destination}.XXXXXX")
  trap '[[ ! -e "$temporary" ]] || rm -- "$temporary"' EXIT
  openssl x509 -in "$TLS_CA_CERT" -outform DER -out "$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$destination"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  renew=false
  if [[ "${1:-}" == --renew ]]; then renew=true; shift; fi
  [[ $(id -u) -eq 0 && $# -le 1 ]] || { echo 'Run with sudo: pi-certificates.sh [--renew] [CONFIG_FILE]' >&2; exit 1; }
  source "$(dirname "$0")/pi-config.sh"
  load_deploy_config "${1:-}"
  configure_certificates "$renew"
  install -d -m 755 /var/lib/yohaku
  export_public_certificate /var/lib/yohaku/certificates/yohaku.crt
  printf 'Certificate names: %s\nDownload: %s/yohaku.crt\n' "$SITE_HOSTS" "$PUBLIC_ORIGIN"
fi
