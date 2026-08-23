---
name: continuous-workflow
description: Use the selectable OpenCode workflow Lead, Engram-backed state, ownership, recovery, consultants, reviewers, and explicit lifecycle transitions.
metadata:
  version: "1"
  owner: "workflow-lead"
  config: "~/.config/opencode/continuous-workflow/config.json"
---

# Continuous Workflow

This skill applies only when the user explicitly selected `workflow-lead` or invoked a `/work-*` command.

The canonical state lives in Engram through the `workflow_state` custom tool. Conversation text, todos, summaries, and model memory are not authoritative.

## Required toolchain

These tools are mandatory parts of the workflow contract:

1. **Engram** — at session start, confirm the current project with `mem_current_project` or the equivalent exposed Engram tool; search relevant prior context with `mem_context`/`mem_search`; save durable decisions, discoveries, and session summaries with the appropriate `mem_*` tools. `workflow_state` remains the canonical lifecycle record.
2. **CodeGraph** — for structural questions, call `codegraph_codegraph_explore` when available. If the MCP tool is unavailable, use the installed `codegraph` CLI. Resolve the project root, initialize `.codegraph/` when needed, and only then use broad filesystem inspection as a documented fallback.
3. **Context7** — for external library, framework, or API behavior, resolve the library with Context7 and query its documentation before making a claim. If Context7 is unavailable, mark the claim unverified and ask for direction instead of relying on memory.

The Lead and every specialist must apply this ordering. Tool unavailability is a visible blocker, not permission to silently substitute unsupported evidence.

Required discipline:

1. Read status before acting.
2. Start a change only when its identifier, goal, and acceptance criteria are known.
3. Pass `expected_version` to every mutation.
4. Keep ownership with `workflow-lead`.
5. Use `workflow-consultant` and `workflow-reviewer` for independent advice.
6. Record checkpoints and consultations.
7. Recover stale ownership explicitly after restart or compaction.
8. Complete only after verification and acceptance criteria pass.

## Configured routing

The optional `workflow-ai configure` command owns the workflow configuration. Read `~/.config/opencode/continuous-workflow/config.json` at the beginning of a session. The `lead_model`, area model map, `reviewer_model`, `review_policy`, `consultation_policy`, and `engram_url` are authoritative for this workflow only. The model values are synchronized into the `workflow-*` agent frontmatter; never edit the existing OpenCode configuration to change them.

The workflow is self-contained and selectable. Do not modify unrelated OpenCode agents, commands, skills, plugins, MCP servers, or the configured default agent.
