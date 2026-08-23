# Selectable Continuous Workflow for OpenCode

This package is additive. It does not replace or remove Gentle-AI, existing OpenCode agents, commands, skills, plugins, MCP servers, or the configured default agent.

## Components

- `agents/workflow-lead.md`: selectable primary Lead.
- `agents/workflow-consultant.md`: read-only exploration consultant.
- `agents/workflow-reviewer.md`: read-only acceptance/risk reviewer.
- `agents/workflow-{discovery,architecture,frontend,backend,security,reliability}.md`: read-only area specialists with independently configurable models.
- `tools/workflow_state.ts`: Engram-backed state tool with version checks and per-change locking.
- `plugins/continuous_workflow.ts`: opt-in compaction reminder; inert outside `workflow-lead` sessions.
- `skills/continuous-workflow/SKILL.md`: protocol loaded only by the new agents.
- `commands/work*.md`: selectable workflow commands.

## Activation

Install the additive bundle from a clone:

```bash
./install.sh
workflow-ai doctor
```

```bash
opencode --agent workflow-lead
```

For an interactive launcher equivalent to the Gentle-AI terminal experience:

```bash
workflow-ai configure
workflow-ai start --dir /path/to/project
workflow-ai status change-id
```

The launcher stores only its own configuration at `~/.config/opencode/continuous-workflow/config.json` and synchronizes only `workflow-*` agent model lines. It never changes `opencode.json`, the default agent, or Gentle-AI files.

Or select `workflow-lead` from OpenCode's agent picker. The existing default agent is intentionally unchanged.

## State

Engram stores one compact state observation per change with topic key `workflow/<change-id>`. The custom tool serializes mutations with a lock under `~/.local/share/opencode/continuous-workflow/locks/` and requires the current `expected_version` for every mutation.

## Deliberate limits

The workflow tool does not call Gentle-AI, does not edit existing configuration, and does not treat conversation text or todos as canonical state. The compaction hook is advisory; recovery is performed by the state tool.

See `COMPATIBILITY.md` for the post-upgrade checks and recovery path.
