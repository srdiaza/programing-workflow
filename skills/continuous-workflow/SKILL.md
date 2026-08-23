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

The workflow is additive. Do not modify, invoke, or depend on Gentle-AI, its agents, commands, skills, plugins, or default-agent setting.
