#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCODE_ROOT="${OPENCODE_CONFIG_ROOT:-${HOME}/.config/opencode}"
config_file="${OPENCODE_ROOT}/opencode.json"
fragment_file="${ROOT_DIR}/opencode.mcp.json"
context7_url="${CONTEXT7_URL:-https://mcp.context7.com/mcp}"

mkdir -p "${OPENCODE_ROOT}"
if [[ -e "${config_file}" ]]; then
  command -v jq >/dev/null 2>&1 || { echo "jq is required to verify or add MCP registrations" >&2; exit 1; }
  jq empty "${config_file}" >/dev/null || { echo "Invalid JSON in ${config_file}" >&2; exit 1; }
  if ! jq -e '.mcp.engram and .mcp.context7 and .mcp.codegraph' "${config_file}" >/dev/null; then
    cp "${config_file}" "${config_file}.continuous-workflow.bak"
    tmp_file="$(mktemp "${config_file}.continuous-workflow.XXXXXX")"
    jq --arg context7_url "${context7_url}" '
      .mcp = (.mcp // {})
      | if .mcp.engram == null then .mcp.engram = {
          "type": "local",
          "command": ["engram", "mcp", "--tools=agent"],
          "enabled": true
        } else . end
      | if .mcp.context7 == null then .mcp.context7 = {
          "type": "remote",
          "url": $context7_url,
          "enabled": true
        } else . end
      | if .mcp.codegraph == null then .mcp.codegraph = {
          "type": "local",
          "command": ["codegraph", "serve", "--mcp"],
          "enabled": true
        } else . end
    ' "${config_file}" > "${tmp_file}"
    mv "${tmp_file}" "${config_file}"
  fi
  jq -e '.mcp.engram and .mcp.context7 and .mcp.codegraph' "${config_file}" >/dev/null || {
    echo "MCP registrations are incomplete. Review ${fragment_file} and ${config_file}." >&2
    exit 1
  }
else
  cp "${fragment_file}" "${config_file}"
fi

echo "MCP registrations verified: Engram, Context7, CodeGraph"
