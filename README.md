# Programing Workflow

An independent, selectable workflow for OpenCode. It gives one Lead ownership of the goal, plan, implementation, verification, recovery, and delivery while read-only specialists provide evidence-backed advice.

## Install

```bash
git clone https://github.com/srdiaza/programing-workflow.git
cd programing-workflow
./install.sh
workflow-ai doctor
```

The installer installs the workflow agents, commands, skill, state tool, plugin, Engram runtime, and MCP registrations. Existing OpenCode settings are merged additively; existing values are preserved.

## Start

```bash
workflow-ai configure
workflow-ai start --dir /path/to/project
workflow-ai run --dir /path/to/project "implement feature X"
workflow-ai status feature-x
workflow-ai resume feature-x
```

The workflow is explicitly selected. Starting OpenCode normally does not select it.

## Required toolchain

The agents use three shared tools as part of their operating contract:

- Engram: canonical cross-session memory and workflow persistence. The installer pins the runtime version and registers its MCP server.
- CodeGraph: structural repository intelligence. Use `codegraph_codegraph_explore` when exposed; otherwise use the `codegraph` CLI and initialize a project index before broad searches.
- Context7: current library and framework documentation. Resolve a library first, then query its official documentation before relying on external API behavior.

If a required tool is unavailable, the agent reports the missing capability instead of inventing an answer or silently treating a broad filesystem search as equivalent evidence.

## Configuration

`workflow-ai configure` stores the workflow-only configuration at:

```text
~/.config/opencode/continuous-workflow/config.json
```

It configures the Lead model, each area specialist model, reviewer model, consultation/review policy, and Engram HTTP endpoint. The configuration is synchronized only into `workflow-*` agents.

## State and recovery

Engram stores one canonical state observation per change using topic `workflow/<change-id>`. The state tool uses expected versions, ownership leases, and filesystem locks. After a restart or compaction, the Lead reloads state before acting and explicitly recovers stale ownership.

See `COMPATIBILITY.md` for upgrade checks and `engram/README.md` for the pinned Engram dependency.
