#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_ROOT="${OPENCODE_CONFIG_ROOT:-${HOME}/.config/opencode}"
WORKFLOW_ROOT="${OPENCODE_ROOT}/continuous-workflow"

bash "${ROOT_DIR}/scripts/install-engram.sh"
bash "${ROOT_DIR}/scripts/install-codegraph.sh"

mkdir -p "${OPENCODE_ROOT}/agents" "${OPENCODE_ROOT}/commands" "${OPENCODE_ROOT}/plugins" \
  "${OPENCODE_ROOT}/skills/continuous-workflow" "${OPENCODE_ROOT}/tools" "${WORKFLOW_ROOT}" "${HOME}/.local/bin"

for file in "${ROOT_DIR}"/agents/workflow-*.md; do
  target="${OPENCODE_ROOT}/agents/$(basename -- "${file}")"
  sed \
    -e "s|__OPENCODE_ROOT__|${OPENCODE_ROOT}|g" \
    -e "s|__CONTINUOUS_WORKFLOW_STATE_DIR__|${HOME}/.local/share/opencode/continuous-workflow|g" \
    -e "s|__OPENCODE_TOOL_OUTPUT_DIR__|${HOME}/.local/share/opencode/tool-output|g" \
    "${file}" > "${target}"
done
for file in "${ROOT_DIR}"/commands/work-*.md; do cp "${file}" "${OPENCODE_ROOT}/commands/"; done
cp "${ROOT_DIR}/plugins/continuous_workflow.ts" "${OPENCODE_ROOT}/plugins/"
cp "${ROOT_DIR}/skills/continuous-workflow/SKILL.md" "${OPENCODE_ROOT}/skills/continuous-workflow/"
cp "${ROOT_DIR}/tools/workflow_state.ts" "${OPENCODE_ROOT}/tools/"
cp "${ROOT_DIR}/cli/workflow-ai.ts" "${WORKFLOW_ROOT}/"
cp "${ROOT_DIR}/continuous-workflow/runtime.ts" "${WORKFLOW_ROOT}/"
cp "${ROOT_DIR}/cli/workflow-ai" "${HOME}/.local/bin/workflow-ai"
cp "${ROOT_DIR}/opencode.mcp.json" "${WORKFLOW_ROOT}/"
mkdir -p "${WORKFLOW_ROOT}/scripts"
cp "${ROOT_DIR}/scripts/"*.sh "${WORKFLOW_ROOT}/scripts/"
chmod 0755 "${HOME}/.local/bin/workflow-ai"

if [[ ! -e "${WORKFLOW_ROOT}/config.json" ]]; then
  cp "${ROOT_DIR}/config.default.json" "${WORKFLOW_ROOT}/config.json"
fi
cp "${ROOT_DIR}/COMPATIBILITY.md" "${WORKFLOW_ROOT}/"
# Apply the existing workflow configuration to the freshly copied agents.
# This keeps model and permission choices intact across reinstalls/upgrades.
"${HOME}/.local/bin/workflow-ai" sync
bash "${WORKFLOW_ROOT}/scripts/install-mcp.sh"

echo "Continuous Workflow installed under ${OPENCODE_ROOT}"
echo "Run: workflow-ai doctor"
