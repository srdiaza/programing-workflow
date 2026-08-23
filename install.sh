#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_ROOT="${OPENCODE_CONFIG_ROOT:-${HOME}/.config/opencode}"
WORKFLOW_ROOT="${OPENCODE_ROOT}/continuous-workflow"

bash "${ROOT_DIR}/scripts/install-engram.sh"

mkdir -p "${OPENCODE_ROOT}/agents" "${OPENCODE_ROOT}/commands" "${OPENCODE_ROOT}/plugins" \
  "${OPENCODE_ROOT}/skills/continuous-workflow" "${OPENCODE_ROOT}/tools" "${WORKFLOW_ROOT}" "${HOME}/.local/bin"

for file in "${ROOT_DIR}"/agents/workflow-*.md; do
  target="${OPENCODE_ROOT}/agents/$(basename -- "${file}")"
  sed "s|__CONTINUOUS_WORKFLOW_STATE_DIR__|${HOME}/.local/share/opencode/continuous-workflow|g" "${file}" > "${target}"
done
for file in "${ROOT_DIR}"/commands/work-*.md; do cp "${file}" "${OPENCODE_ROOT}/commands/"; done
cp "${ROOT_DIR}/plugins/continuous_workflow.ts" "${OPENCODE_ROOT}/plugins/"
cp "${ROOT_DIR}/skills/continuous-workflow/SKILL.md" "${OPENCODE_ROOT}/skills/continuous-workflow/"
cp "${ROOT_DIR}/tools/workflow_state.ts" "${OPENCODE_ROOT}/tools/"
cp "${ROOT_DIR}/cli/workflow-ai.ts" "${WORKFLOW_ROOT}/"
cp "${ROOT_DIR}/cli/workflow-ai" "${HOME}/.local/bin/workflow-ai"
chmod 0755 "${HOME}/.local/bin/workflow-ai"

if [[ ! -e "${WORKFLOW_ROOT}/config.json" ]]; then
  cp "${ROOT_DIR}/config.default.json" "${WORKFLOW_ROOT}/config.json"
fi
cp "${ROOT_DIR}/COMPATIBILITY.md" "${WORKFLOW_ROOT}/"

config_file="${OPENCODE_ROOT}/opencode.json"
fragment_file="${ROOT_DIR}/opencode.mcp.json"
if [[ -e "${config_file}" ]]; then
  if ! grep -q '"codegraph"[[:space:]]*:' "${config_file}"; then
    command -v perl >/dev/null 2>&1 || { echo "perl is required to add the CodeGraph MCP entry without reformatting ${config_file}" >&2; exit 1; }
    cp "${config_file}" "${config_file}.continuous-workflow.bak"
    perl -0pi -e 's{(    "engram": \{\n      "command": \[\n        "engram",\n        "mcp",\n        "--tools=agent"\n      \],\n      "type": "local"\n    \})\n  \},\n  "permission":}{$1,\n    "codegraph": {\n      "type": "local",\n      "command": [\n        "codegraph",\n        "serve",\n        "--mcp"\n      ],\n      "enabled": true\n    }\n  },\n  "permission":}s' "${config_file}"
  fi
  command -v jq >/dev/null 2>&1 || { echo "jq is required to verify MCP registrations" >&2; exit 1; }
  jq -e '.mcp.engram and .mcp.context7 and .mcp.codegraph' "${config_file}" >/dev/null || {
    echo "MCP registrations are incomplete. Review ${fragment_file} and ${config_file}." >&2
    exit 1
  }
else
  cp "${fragment_file}" "${config_file}"
fi

echo "Continuous Workflow installed under ${OPENCODE_ROOT}"
echo "Run: workflow-ai doctor"
