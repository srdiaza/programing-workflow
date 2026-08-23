# Programing Workflow

An independent, selectable workflow for OpenCode. It gives one Lead ownership of the goal, plan, implementation, verification, recovery, and delivery while read-only specialists provide evidence-backed advice.

## First use — step by step

You install the workflow once on your computer. After that, you select it when you want to use it in a project.

### 1. Install it once

```bash
git clone https://github.com/srdiaza/programing-workflow.git
cd programing-workflow
./install.sh
workflow-ai doctor
```

The installer adds the workflow to your user OpenCode configuration. It does not replace your normal OpenCode agent, delete existing agents, or add project files to the repositories you work on.

### 2. Configure the models once

Run:

```bash
workflow-ai configure
```

It asks which model should be used for:

- the Lead, who owns the complete change;
- discovery and architecture;
- frontend and backend work;
- security and reliability;
- the reviewer.

It also asks whether consultation and review are required or optional. These choices apply only to the `workflow-*` agents. Your normal OpenCode configuration and default agent are left unchanged.

You can run `workflow-ai configure` again whenever you want to change the model assigned to an area.

### 3. Open a project and select the Lead

Go to the project you want to work on:

```bash
cd /path/to/your-project
opencode
```

Select `workflow-lead` in OpenCode's agent selector. The equivalent one-line launch is:

```bash
opencode --agent workflow-lead
```

The workflow is active only when `workflow-lead` is selected. Opening OpenCode normally continues to use your regular agent.

### 4. Describe the work in plain language

You do not need to write a special technical command. Tell the Lead what you want, for example:

```text
Implement user password recovery. It must send an email, expire the token after 30 minutes,
prevent token reuse, include tests, and preserve the existing login API.
```

For a larger request, include the desired result, important constraints, and how you will know it is finished. The Lead can ask questions when something material is unclear.

### 5. Let the workflow run

For the first request in a project, the Lead works through these stages:

1. **Discovery** — reads the project instructions, local skills, architecture, tests, and relevant existing code. It also loads useful prior context from Engram and uses CodeGraph to understand the repository structure.
2. **Planning** — defines a stable change ID, the goal, acceptance criteria, boundaries, and the next action.
3. **Consultation** — asks the relevant area specialists for independent findings when the configured policy or risk requires it.
4. **Implementation** — the Lead makes the changes. Specialists advise; the Lead remains responsible for the actual edit.
5. **Verification** — runs the appropriate tests and checks, uses Context7 for current library documentation when an external API is involved, and asks the reviewer for an independent review when required.
6. **Ready** — reports what is finished and waits for your confirmation. A ready change is still open, so you can request corrections or additional tests without starting a new workflow.
7. **Completed** — only happens after you explicitly confirm that the change should be closed.

The state and checkpoints are kept in Engram, so a restart or compaction does not make the Lead start from memory alone.

### 6. Continue, adjust, or close the same change

While the change is active or ready, you can say things such as:

```text
Adjust the error message on the empty state.
Add a test for an expired token.
Try this behavior with the existing API client.
```

The Lead keeps the same change ID, records the adjustment, verifies it, and continues the existing workflow. It does not create a new flow just because the request is a small follow-up.

When the Lead says the change is ready, close it explicitly with either:

```bash
workflow-ai complete <change-id>
```

or, inside OpenCode:

```text
/work-complete <change-id>
```

You can also simply confirm in the conversation when the Lead asks whether it should close the change.

## Everyday commands

The `workflow-ai` wrapper is optional; it is a convenient way to launch OpenCode or inspect workflow state.

```bash
# Interactive workflow session
workflow-ai start --dir /path/to/project

# One non-interactive request
workflow-ai run --dir /path/to/project "Implement feature X"

# Inspect or continue a persisted change
workflow-ai status <change-id>
workflow-ai resume <change-id>

# Explicitly close a change that is ready
workflow-ai complete <change-id>
```

The Lead normally creates or derives the change ID. You can request a clear one in your first message, for example: `Use change-id password-recovery.`

## What each part does

- **workflow-lead** — the only agent that owns the goal, plan, edits, verification, and decision to request completion.
- **workflow-consultant and area specialists** — read-only advisors for discovery, architecture, frontend, backend, security, and reliability.
- **workflow-reviewer** — an independent review pass when the review policy requires it.
- **Engram** — stores durable memory, ownership, checkpoints, and recovery state across sessions.
- **CodeGraph** — maps repository structure, symbols, callers, callees, and impact before broad searches.
- **Context7** — supplies current documentation for libraries, frameworks, and external APIs.
- **workflow_state** — the canonical state machine. It tracks phase, owner, version, next action, consultations, and history.

## Required tools and dependency updates

The workflow expects Engram, CodeGraph, and Context7 to be available:

```bash
workflow-ai deps status
workflow-ai deps install
workflow-ai deps update
```

`deps install` fills missing local runtimes and MCP registrations. `deps update` updates the pinned Engram release and npm CodeGraph version, then verifies the registrations. Context7 is a remote MCP in this setup, so it has no local binary to replace; its service is updated by its provider while this workflow installs and verifies its registration.

If a required tool is unavailable, the Lead reports the capability gap instead of silently inventing evidence.

## Configuration location

The workflow-only settings live at:

```text
~/.config/opencode/continuous-workflow/config.json
```

This file contains the Lead model, area model map, reviewer model, consultation/review policies, and Engram endpoint. It is synchronized only into `workflow-*` agents.

## Project setup and recovery

There is no mandatory project-specific initialization command. On the first request, the Lead reads the project's own `AGENTS.md`, rules, skills, architecture, and tests. CodeGraph initializes its project index when needed. Project-specific files stay in the project; workflow state stays in Engram.

After a restart, use:

```bash
workflow-ai resume <change-id>
```

The Lead reloads the canonical state, recovers a stale owner when appropriate, and continues from the saved phase instead of starting over.

See [COMPATIBILITY.md](COMPATIBILITY.md) for upgrade checks and [engram/README.md](engram/README.md) for the pinned Engram dependency.
