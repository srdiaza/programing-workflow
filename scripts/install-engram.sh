#!/usr/bin/env bash
set -euo pipefail

ENGRAM_VERSION="${ENGRAM_VERSION:-1.20.0}"
INSTALL_DIR="${ENGRAM_INSTALL_DIR:-${HOME}/.local/bin}"

if command -v engram >/dev/null 2>&1; then
  echo "Engram already available: $(command -v engram)"
  engram version 2>/dev/null || true
  exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required to install Engram" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required to install Engram" >&2; exit 1; }

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) asset="engram_${ENGRAM_VERSION}_linux_amd64.tar.gz" ;;
  Linux:aarch64|Linux:arm64) asset="engram_${ENGRAM_VERSION}_linux_arm64.tar.gz" ;;
  Darwin:x86_64|Darwin:amd64) asset="engram_${ENGRAM_VERSION}_darwin_amd64.tar.gz" ;;
  Darwin:arm64) asset="engram_${ENGRAM_VERSION}_darwin_arm64.tar.gz" ;;
  *) echo "Unsupported platform for the pinned Engram release: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

base_url="https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

curl -fsSL "${base_url}/${asset}" -o "${tmp_dir}/${asset}"
curl -fsSL "${base_url}/checksums.txt" -o "${tmp_dir}/checksums.txt"

expected="$(awk -v name="${asset}" '$2 == name { print $1 }' "${tmp_dir}/checksums.txt")"
[[ -n "${expected}" ]] || { echo "No checksum found for ${asset}" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp_dir}/${asset}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "${tmp_dir}/${asset}" | awk '{print $1}')"
fi
[[ "${actual}" == "${expected}" ]] || { echo "Engram checksum mismatch" >&2; exit 1; }

mkdir -p "${INSTALL_DIR}"
tar -xzf "${tmp_dir}/${asset}" -C "${tmp_dir}"
binary="$(find "${tmp_dir}" -type f -name engram -perm -u+x -print -quit)"
[[ -n "${binary}" ]] || { echo "Engram binary not found in release archive" >&2; exit 1; }
install -m 0755 "${binary}" "${INSTALL_DIR}/engram"
echo "Installed Engram ${ENGRAM_VERSION} at ${INSTALL_DIR}/engram"
