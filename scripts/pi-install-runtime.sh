#!/usr/bin/env bash
# Run as the application user, never as root.
set -euo pipefail
[[ $(id -u) -ne 0 ]] || { echo 'Run as the application user.' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(tr -d '[:space:]' < "$root/.nvmrc")
case $(uname -m) in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
runtime="$HOME/.local/share/yohaku/node-v${version}-linux-${arch}"
if [[ ! -x "$runtime/bin/node" ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  archive="node-v${version}-linux-${arch}.tar.xz"
  base="https://nodejs.org/dist/v${version}"
  curl --fail --show-error --location "$base/$archive" -o "$work/$archive"
  curl --fail --show-error --location "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work"; awk -v file="$archive" '$2 == file' SHASUMS256.txt > checksum; test -s checksum; sha256sum -c checksum)
  mkdir -p "$(dirname "$runtime")"
  tar -xJf "$work/$archive" -C "$(dirname "$runtime")"
fi
export PATH="$runtime/bin:$PATH"
node --version
npm install --global --prefix "$HOME/.local/share/yohaku/codex" @openai/codex@0.160.1
"$HOME/.local/share/yohaku/codex/bin/codex" --version
cd "$root"
npm ci
npm run build
