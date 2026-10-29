#!/usr/bin/env bash
# Generate a local developer self-signed certificate for PWA development.
# Usage: bash scripts/dev-tls.sh [--force] [HOST] [CERT_DIR]
# The certificate covers localhost/127.0.0.1 plus HOST (an IPv4 address or DNS
# name; defaults to the first non-loopback IPv4 address), and is marked CA:TRUE
# so iOS/Android can trust it for service-worker installability. Certificates
# live outside the repo. A phone that trusts it trusts anything signed by
# key.pem: keep the key on this machine and remove the certificate from the
# phone when done.
set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
  shift
fi

HOST="${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
HOST="${HOST:-127.0.0.1}"
CERT_DIR="${2:-$HOME/.local/share/yohaku/dev}"
SAN="DNS:localhost,IP:127.0.0.1"

if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  [[ "$HOST" == "127.0.0.1" ]] || SAN="${SAN},IP:${HOST}"
elif [[ "$HOST" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
  [[ "$HOST" == "localhost" ]] || SAN="${SAN},DNS:${HOST}"
else
  echo "HOST 应为 IPv4 地址或主机名，例如 192.168.1.50。" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "需要 openssl。" >&2; exit 1; }

mkdir -p -m 700 "$CERT_DIR"
if [[ $FORCE -eq 0 && -e "$CERT_DIR/key.pem" && -e "$CERT_DIR/cert.pem" ]]; then
  echo "证书已存在：$CERT_DIR（如需重新生成请先删除或传入 --force）。" >&2
  openssl x509 -in "$CERT_DIR/cert.pem" -noout -ext subjectAltName >&2 2>/dev/null || true
  exit 0
fi
if [[ $FORCE -eq 0 && ( -e "$CERT_DIR/key.pem" || -e "$CERT_DIR/cert.pem" ) ]]; then
  echo "证书目录 $CERT_DIR 中仅存在单个证书或私钥文件（如需重新生成请传入 --force）。" >&2
  exit 1
fi

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
  -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
  -subj "/CN=${HOST}" \
  -addext "subjectAltName=${SAN}" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth,clientAuth" \
  >/dev/null 2>&1
chmod 600 "$CERT_DIR/key.pem"

echo "证书已生成："
echo "  TLS_KEY=$CERT_DIR/key.pem"
echo "  TLS_CERT=$CERT_DIR/cert.pem"
echo "  SAN=$SAN"
