# Compatibility and upgrades

The workflow is installed as user-owned OpenCode extensions with names under the `workflow-*` namespace. The installer merges only missing MCP entries and preserves existing configuration values.

After upgrading OpenCode or the workflow dependencies, run:

```bash
workflow-ai deps status
workflow-ai doctor
workflow-ai sync
```

`doctor` checks OpenCode discovery, the state tool, Engram, CodeGraph, Context7, all area agents, and the MCP registrations. `sync` reapplies only model lines from the workflow configuration.

Use `workflow-ai deps install` to fill missing local runtimes and registrations, or `workflow-ai deps update` to update the pinned Engram and CodeGraph versions. Context7 is deliberately represented as a remote MCP URL; its service version is controlled by the provider, while this workflow installs and verifies the registration.

An ordinary OpenCode upgrade should preserve unknown files in `~/.config/opencode/`. A full configuration reset or a tool that prunes unknown extensions can remove them. Re-run `./install.sh` from this repository to restore the additive bundle. The installer does not delete unrelated files.

The workflow relies on global agent/command/skill/tool/plugin discovery, the `--agent` and `--model` CLI flags, the OpenCode plugin API, Engram MCP/HTTP, CodeGraph, and Context7. If `doctor` reports an incompatible API, stop before starting a change and inspect the installed versions.
