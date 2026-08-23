#!/usr/bin/env bash
set -euo pipefail

CODEGRAPH_VERSION="${CODEGRAPH_VERSION:-1.5.0}"
if command -v codegraph >/dev/null 2>&1 && [[ "${CODEGRAPH_UPDATE:-0}" != "1" ]]; then
  echo "CodeGraph already available: $(command -v codegraph)"
  codegraph --version 2>/dev/null || true
  exit 0
fi

command -v npm >/dev/null 2>&1 || { echo "npm is required to install CodeGraph" >&2; exit 1; }
npm_cache="${WORKFLOW_NPM_CACHE:-${TMPDIR:-/tmp}/programing-workflow-npm-cache}"
mkdir -p "${npm_cache}"
NPM_CONFIG_CACHE="${npm_cache}" npm install --global "@colbymchenry/codegraph@${CODEGRAPH_VERSION}"
echo "Installed CodeGraph ${CODEGRAPH_VERSION}"
