---
name: continuous-workflow
description: Use the selectable OpenCode workflow Lead, Engram-backed state, ownership, recovery, consultants, reviewers, and explicit lifecycle transitions.
metadata:
  version: "2"
  owner: "workflow-lead or workflow-lead-*"
  config: "~/.config/opencode/continuous-workflow/config.json"
---

# Continuous Workflow v2

This skill applies only to `workflow-lead`, its generated profiles, and the `workflow-*` subagents launched by that Lead. It is independent of Gentle AI, SDD, OpenSpec, and every other orchestrator. Never invoke or consume their agents, commands, phases, artifacts, or memory.

## Authority

- `workflow_state` v2 is canonical. Conversation, todos, plans, and model memory are not.
- `workflow/contracts/<change-id>.md` is the authoritative user-approved functional scope.
- Only the Lead may call `workflow_state`, write the contract, make technical decisions, or change lifecycle phase.
- Only `workflow-implementer` may write application code and tests.
- Specialists and Reviewer are read-only and report to the Lead.

The Lead must read status before acting, pass the latest `expected_version` to every mutation, recover the same change after restart, and never replace missing state with a new change ID.

## Evidence tools

- Engram persistence is owned through `workflow_state`. Subagents do not write Engram.
- Use CodeGraph for structural questions when a valid index already exists. Read-only subagents must never initialize, sync, repair, or mutate `.codegraph`; they fall back to `rg`, repository reads, and Git inspection while disclosing the limitation.
- Use Context7 when an external library/framework/API claim materially depends on current documentation. If unavailable, mark only that claim unverified; unrelated repository work may continue.
- Tests, architecture checks, tenant checks, migration checks, linters, and other non-destructive validation run automatically under the recorded verification plan. Focused verification is the default. A complete suite is selected only for an explicit trigger (project rule, migrations/models, shared contract, auth/tenant/accounting core, dependencies/infrastructure, test/CI change, reproduced CI failure, or user request), then runs once after code is frozen by `workflow-implementer`. Lead and Reviewer do not repeat it; the Reviewer may run only a concrete focused probe. Never clean a worktree to make validation pass: declared untracked test artifacts are preserved and excluded only from the untracked fingerprint; tracked or undeclared changes remain reviewable.

## Enforced lifecycle

1. Status/start and read-only inspection.
2. Non-protected delivery branch/worktree recorded with `delivery_prepare`.
3. Functional contract drafted, fully presented, and explicitly approved at its exact hash.
4. Atomic current/future/non-goal capabilities recorded.
5. Relevant specialist consultation and Lead reconciliation.
6. Plain-language implementation brief presented and recorded.
7. Verification plan recorded: tier, explicit reason, exact checks, and `workflow-implementer` as the sole execution owner.
8. Implementation delegated to `workflow-implementer`; the Lead inspects the actual diff.
9. Verification recorded against the current tree fingerprint.
10. Independent review against that same fingerprint.
11. Findings enter the correction loop: direct `verification → implementation → verification`, affected checks only, then a fresh review. The initial contract/capability/brief gates remain intact unless scope changes.
12. `ready`, explicit user confirmation, then `complete`.

The plugin enforces these gates. A prompt, todo, prior approval, passing build, or working partial implementation cannot bypass them.

## Subagent report contract

Every specialist and Reviewer returns:

- `Verdict`: `PASS` only when there are zero findings; otherwise `BLOCKED`.
- `Coverage`: capabilities inspected and evidence used.
- `Findings`: each with ID, severity, category, exact location, evidence, impact, required correction, and verification after correction.
- `Suggestions`: genuinely optional preferences only, separate from findings.

Every concrete defect, regression risk, missing validation, contract mismatch, scope violation, unexpected mutation, or pre-existing/out-of-scope defect is a finding and therefore blocks delivery. Severity orders correction; it never makes a finding non-blocking. Do not say `Ship it` while findings remain. The Lead decides whether a materially out-of-scope correction needs user direction, but the finding must remain visible until resolved.

## Configuration

`workflow-ai configure` owns the selectable workflow profile. The selected profile's model routing, consultation policy, review policy, and safe permissions apply only to this workflow. Never modify unrelated OpenCode agents, commands, skills, plugins, MCP servers, or the configured default agent.
