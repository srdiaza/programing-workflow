# Compatibility and upgrades

The workflow is installed as user-owned OpenCode extensions with names under the `workflow-*` namespace. The installer merges only missing MCP entries and preserves existing configuration values.

After upgrading OpenCode or the workflow dependencies, run:

```bash
workflow-ai deps status
workflow-ai doctor
workflow-ai sync
```

`doctor` checks OpenCode discovery, the state tool, Engram, CodeGraph, Context7, all area agents, and the MCP registrations. `sync` reapplies model, variant, routing, and permission settings to the default agents and regenerates every configured profile family.

Profiles are additive generated agents under the `workflow-*` namespace. An OpenCode upgrade does not own or overwrite them, but a full config reset can remove them. Re-run the repository installer; it preserves the configuration file and regenerates all profile agents from it. Repeated syncs are safe and do not accumulate profile suffixes.

Use `workflow-ai deps install` to fill missing local runtimes and registrations, or `workflow-ai deps update` to update the pinned Engram and CodeGraph versions. Context7 is deliberately represented as a remote MCP URL; its service version is controlled by the provider, while this workflow installs and verifies the registration.

An ordinary OpenCode upgrade should preserve unknown files in `~/.config/opencode/`. A full configuration reset or a tool that prunes unknown extensions can remove them. Re-run `./install.sh` from this repository to restore the additive bundle. The installer does not delete unrelated files.

The workflow relies on global agent/command/skill/tool/plugin discovery, the `--agent` and `--model` CLI flags, the OpenCode plugin API, Engram MCP/HTTP, CodeGraph, and Context7. If `doctor` reports an incompatible API, stop before starting a change and inspect the installed versions.

Completion is an explicit user decision. A verified change remains `ready` until the user invokes `workflow-ai complete <change-id>` or `/work-complete <change-id>`; this leaves room for follow-up adjustments without creating a second change.
