---
name: continuous-workflow
description: Use the selectable OpenCode workflow Lead, Engram-backed state, ownership, recovery, consultants, reviewers, and explicit lifecycle transitions.
metadata:
  version: "2"
  owner: "workflow-lead or workflow-lead-*"
  config: "~/.config/opencode/continuous-workflow/config.json"
---

# Continuous Workflow v2

This skill applies only to `workflow-lead`, its generated profiles, and the `workflow-*` subagents launched by that Lead. It is self-contained. Never invoke or consume agents, commands, phases, artifacts, or memory belonging to another workflow.

## Authority

- `workflow_state` v2 is canonical. Conversation, todos, plans, and model memory are not.
- `workflow/contracts/<change-id>.md` is the authoritative user-approved functional scope.
- Only the Lead may call `workflow_state`, write the contract, make technical decisions, or change lifecycle phase.
- Only `workflow-implementer` may write application code and tests.
- Specialists and Reviewer are read-only and report to the Lead.

The Lead must read status before acting, pass the latest `expected_version` to every mutation, recover the same change after restart, and never replace missing state with a new change ID.

## Request classification

Not every user request asks for code. At `start`, record `workflow_mode: assessment` for investigation, comparison, diagnosis, impact analysis, clarification, or recommendation requests. Use `workflow_mode: implementation` only when the user explicitly asks to add, change, fix, migrate, remove, or otherwise alter application behavior. If an assessment later becomes an implementation, use `workflow_state operation: mode_set workflow_mode: implementation` only after the user explicitly requests applying the change. Never change modes merely to satisfy a gate.

## Evidence tools

- Engram persistence of change state is owned through `workflow_state`; subagents do not write Engram. The Lead may run read-only `mem_search` / `mem_context` / `mem_get_observation` at the start of Discovery to seed context from prior work. The Lead may also write **durable, non-state knowledge** with `mem_save`/`mem_update` (type decision, architecture, bugfix, pattern, discovery, learning, or config) — what changed, why, and anything non-obvious — ideally at `ready`/`complete` and after a key correction. Canonical change state (schema, changeId, expected_version, tree fingerprint, verification/review records) must never go through `mem_save`; that remains the sole job of `workflow_state`, and the gate blocks such writes. Every other `engram_mem_*` tool (delete, session, judge, pin, compare, passive capture) stays blocked for every workflow agent.
- Use CodeGraph for structural questions. Always pass the repository root as `projectPath` to every query (CodeGraph has no default project). When a valid index exists, use it before broad sequential reads. Read-only subagents and the Lead never initialize, sync, repair, or mutate `.codegraph`; if no index exists, fall back to `rg`, repository reads, and Git inspection while disclosing the missing index, and the Lead asks the user to run `codegraph init <project-root>` once. Do not use generic resource discovery for workflow state or configured MCP servers; `workflow_state` is a native tool, and an unsupported resource query is not a blocker. Context budget: read 1–3 files inline, delegate one narrow mapper for 4+ files, and prefer `codegraph_explore` over dumps.
- Use Context7 when an external library/framework/API claim materially depends on current documentation. If unavailable, mark only that claim unverified; unrelated repository work may continue.
- Tests, architecture checks, tenant checks, migration checks, linters, and other non-destructive validation run automatically under the recorded verification plan. Focused verification is the default. A complete suite is selected only for an explicit trigger (project rule, migrations/models, shared contract, auth/tenant/accounting core, dependencies/infrastructure, test/CI change, reproduced CI failure, or user request), then runs once after code is frozen by `workflow-implementer` as part of the initial implementation handoff. The Lead records that final evidence directly when it covers the current candidate; it must not delegate a second verification task to the same Implementer. A verification-only task is allowed only for checks explicitly missing from the handoff, and must not repeat completed checks or a complete suite. After any correction following verification or review, run only the checks directly affected by that correction; never rerun the complete suite locally, because CI owns the complete suite for the final candidate. Lead and Reviewer do not repeat it; the Reviewer may run only a concrete focused probe. For `assessment`, the plan is read-only, is owned by `workflow-consultant`, and does not require implementation, delivery preparation, an Implementer receipt, or an independent implementation review. Its receipt is tied to the completed plan and proves read-only execution; it is not invalidated by unrelated changes after the consultant finished. Never clean a worktree to make validation pass: declared untracked test artifacts are preserved and excluded only from the untracked fingerprint; tracked or undeclared changes remain reviewable.

## Enforced lifecycle

Common: status/start with an explicit mode, read-only discovery, functional contract drafted/presented/approved at its exact hash, capability matrix recorded, and specialist findings reconciled.

Assessment track: record a focused read-only verification plan owned by `workflow-consultant`, transition directly `planning → verification`, delegate the evidence plan, record evidence, present the recommendation, then await explicit confirmation to complete. Do not prepare an implementation branch, present an implementation brief, delegate `workflow-implementer`, run an independent implementation review, or run implementation gates.

Implementation track: record a non-protected delivery branch/worktree, present and record the implementation brief, record the verification plan, transition to implementation, delegate the approved package, inspect the diff and final evidence, record verification once, run independent review, enter the correction loop when needed, then write `<project-root>/workflow/result-summary-<change-id>.md` in business language (what changed, what was verified and how, what was not tested, accepted known limitations), then `ready`, explicit user confirmation, and `complete`.

The functional contract is the single approved read-back: it must enumerate the user's actions and observable results in business language so the one contract approval also covers the behavior list. Work does not require a separate read-back approval round.

An assessment may enter the implementation track later through explicit `mode_set`; preserve the assessment contract and findings, and do not restart discovery unnecessarily.

The plugin enforces these gates. A prompt, todo, prior approval, passing build, or working partial implementation cannot bypass them.

## Subagent report contract

Every specialist and Reviewer returns:

- `Verdict`: `PASS` only when there are zero findings; otherwise `BLOCKED`.
- `Coverage`: capabilities inspected and evidence used.
- `Findings`: each with ID, severity, category, exact location, evidence, impact, required correction, and verification after correction.
- `Suggestions`: genuinely optional preferences only, separate from findings.

Every concrete defect, regression risk, missing validation, contract mismatch, scope violation, unexpected mutation, or pre-existing/out-of-scope defect is a finding and therefore blocks delivery. Severity orders correction; it never makes a finding non-blocking. Do not say `Ship it` while findings remain. The Lead decides whether a materially out-of-scope correction needs user direction, but the finding must remain visible until resolved.

## Configuration

`workflow-ai configure` owns the selectable workflow profile. The selected profile's model routing, consultation policy, review policy, and safe permissions apply only to this workflow. Use consultants for exploration and assessment verification, and reviewers for independent read-only checks. Never modify unrelated OpenCode agents, commands, skills, plugins, MCP servers, or the configured default agent.
