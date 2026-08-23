# Compatibility and upgrades

The workflow is installed as user-owned OpenCode extensions. It does not change `opencode.json`, `default_agent`, Gentle-AI files, or existing agent names.

After upgrading OpenCode, run:

```bash
workflow-ai doctor
workflow-ai sync
```

`doctor` checks that OpenCode can discover `workflow-lead`, that the `workflow_state` tool is available, that all area agents exist, and that Engram is installed. `sync` reapplies only model lines from the workflow configuration to `workflow-*` agents.

An ordinary OpenCode upgrade should preserve unknown files in `~/.config/opencode/`. An uninstall, a full configuration reset, or a third-party sync that prunes unknown files can remove them. In that case reinstall this additive bundle from its source repository; do not run a Gentle-AI restore or alter the existing default agent.

The workflow relies on stable OpenCode surfaces: global agent/command/skill/tool/plugin discovery, the `--agent` and `--model` CLI flags, and the plugin package API. The plugin hook is advisory only; Engram plus `workflow_state` remains the authority. If the API check fails, stop and inspect the installed OpenCode version before running a change.
