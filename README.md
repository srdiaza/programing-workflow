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

For each assignment it also asks for the model's thinking level. OpenCode exposes the levels supported by that specific model, so the workflow does not pretend that every provider uses the same scale.

It also asks whether consultation and review are required or optional, and which Lead permissions should run automatically. These choices apply only to the `workflow-*` agents. Your normal OpenCode configuration and default agent are left unchanged.

You can run `workflow-ai configure` again whenever you want to change the model assigned to an area.

### Perfiles independientes

Si quieres tener otra combinación completa —por ejemplo, un Lead distinto cuando se acaba el uso de un proveedor— crea un perfil. El perfil normal no se toca:

```bash
workflow-ai profile create deepseek
workflow-ai configure --profile deepseek
```

El segundo comando abre el mismo TUI, pero guarda los cambios dentro de `profiles.deepseek`. Ahí puedes asignar el Lead, cada área, el reviewer, sus niveles de pensamiento, las políticas y los permisos de ese perfil. No modifica los valores del perfil `default`.

Al guardar se generan agentes globales independientes:

```text
workflow-lead-deepseek
workflow-discovery-deepseek
workflow-architecture-deepseek
workflow-frontend-deepseek
workflow-backend-deepseek
workflow-security-deepseek
workflow-reliability-deepseek
workflow-reviewer-deepseek
```

Selecciona `workflow-lead-deepseek` en OpenCode, o lánzalo directamente:

```bash
opencode --agent workflow-lead-deepseek
# alternativa equivalente:
workflow-ai start --profile deepseek --dir /path/to/your-project
```

La selección cambia toda la familia del workflow, no solo el Lead: el Lead delega en los especialistas y reviewer del mismo sufijo. El estado, checkpoints, Engram, CodeGraph, Context7 y reglas de seguridad siguen siendo los mismos mecanismos globales. Para ver perfiles o retirar uno:

```bash
workflow-ai profile list
workflow-ai profile remove deepseek
```

Retirar un perfil solo elimina su entrada de configuración y sus agentes generados; no toca el perfil normal ni archivos de tus proyectos.

The configuration opens as a full-screen terminal interface. The left panel contains the Lead, specialist areas, Reviewer, policies, permissions, and the final review screen; the right panel shows the active item's description and current value. Use `↑`/`↓` to navigate and `Enter` to edit. In the model panel, type part of a provider or model name, such as `luna`, `deepseek`, `kimi`, or `minimax`, then use `↑`/`↓` to move through the filtered matches and `Enter` to choose. Press `Tab` for a model that is not listed. The thinking-level panel uses the same interaction and explains the active level. If the provider does not publish its variants, the workflow lets you enter the provider's variant name manually instead of hiding the setting. Nothing is written until you choose **Revisar y guardar** and confirm with `Enter`; `q` cancels the whole session. Engram's existing configured endpoint is retained automatically and is not requested in this wizard.

The **Permisos** section controls the Lead of the profile currently being edited:

- **Edición de archivos** — whether the Lead may edit without approval (`allow`), must ask (`ask`), or is blocked (`deny`).
- **Comandos shell** — the same policy for Bash commands. `git reset --hard`, destructive clean, `rm -rf`, and `sudo` remain blocked by the workflow's hard safety rules.
- **Git push** — whether a push asks for your approval (`ask`) or remains blocked (`deny`). It is `ask` by default.
- **Subagentes** — whether the approved `workflow-*` consultants and reviewer run automatically, ask first, or are disabled.
- **Fuera del proyecto** — access to directories outside the project. The workflow state directory remains available so recovery continues to work.
- **Preguntas interactivas** — whether the Lead may pause and present a question with options. Set this to `deny` for truly unattended runs.

The defaults preserve normal interactive behavior: editing is automatic, shell and external-directory access ask, `git push` asks, approved subagents run automatically, and the Lead may ask questions. The settings are stored under `permissions` for the default profile or under the selected entry in `profiles` in `~/.config/opencode/continuous-workflow/config.json`; they do not change global OpenCode permissions.

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

This file contains the default Lead model, area model map, reviewer model, consultation/review policies, Engram endpoint, and independent profile entries. It is synchronized only into generated `workflow-*` agents. A profile inherits the default when created, then becomes its own saved snapshot when configured.

The thinking choices are stored beside those model assignments as `lead_variant`, `area_variants`, and `reviewer_variant`. A `default` value leaves the model's native OpenCode behavior unchanged; a named value is written as that agent's OpenCode `variant`.

To apply a hand-edited configuration without changing models, run:

```bash
workflow-ai sync
```

## Project setup and recovery

There is no mandatory project-specific initialization command. On the first request, the Lead reads the project's own `AGENTS.md`, rules, skills, architecture, and tests. CodeGraph initializes its project index when needed. Project-specific files stay in the project; workflow state stays in Engram.

After a restart, use:

```bash
workflow-ai resume <change-id>
```

The Lead reloads the canonical state, recovers a stale owner when appropriate, and continues from the saved phase instead of starting over.

See [COMPATIBILITY.md](COMPATIBILITY.md) for upgrade checks and [engram/README.md](engram/README.md) for the pinned Engram dependency.
