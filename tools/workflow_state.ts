import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"

const WORKFLOW_AGENT = "workflow-lead"
const WORKFLOW_SCHEMA = "continuous-workflow/v1"
const DEFAULT_LEASE_MS = 30 * 60 * 1000
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 2 * DEFAULT_LEASE_MS

const PHASES = ["discovery", "planning", "implementation", "verification", "delivery"] as const
const STATUSES = ["active", "ready", "completed", "blocked", "aborted"] as const
type Phase = (typeof PHASES)[number]
type Status = (typeof STATUSES)[number]

type Owner = {
  agent: string
  sessionID: string
  claimedAt: string
  lastSeenAt: string
  leaseUntil: string
}

type HistoryEntry = {
  version: number
  event: string
  summary: string
  actor: string
  sessionID: string
  at: string
}

type Consultation = {
  kind: "consultation" | "review"
  actor: string
  sessionID: string
  summary: string
  at: string
}

type WorkflowState = {
  schema: typeof WORKFLOW_SCHEMA
  changeId: string
  project: string
  worktree: string
  goal: string
  acceptanceCriteria: string[]
  phase: Phase
  status: Status
  version: number
  owner: Owner
  nextAction: string
  updatedAt: string
  history: HistoryEntry[]
  consultations: Consultation[]
}

type Observation = {
  id?: number
  topic_key?: string
  content?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

function now(): string {
  return new Date().toISOString()
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function safeChangeId(value: string): string {
  const changeId = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(changeId)) {
    throw new Error("change_id must use 1-120 letters, numbers, dots, underscores, or hyphens")
  }
  return changeId
}

function projectFrom(directory: string): string {
  try {
    const remote = Bun.spawnSync(["git", "-C", directory, "remote", "get-url", "origin"])
    if (remote.exitCode === 0) {
      const value = remote.stdout.toString().trim().replace(/\.git$/, "")
      const name = value.split(/[/:]/).pop()
      if (name) return name
    }
  } catch {}

  try {
    const root = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--show-toplevel"])
    if (root.exitCode === 0) {
      const value = root.stdout.toString().trim()
      const name = value.split("/").pop()
      if (name) return name
    }
  } catch {}

  return directory.split("/").filter(Boolean).pop() ?? "unknown-project"
}

function stateRoot(): string {
  const configured = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
  if (configured) return configured
  const home = process.env.HOME ?? "/tmp"
  return pathJoin(home, ".local", "share", "opencode", "continuous-workflow")
}

function runtimeConfig(): Record<string, unknown> {
  const home = process.env.HOME ?? "/tmp"
  const configured = process.env.CONTINUOUS_WORKFLOW_CONFIG ?? pathJoin(home, ".config", "opencode", "continuous-workflow", "config.json")
  try {
    const parsed = JSON.parse(readFileSync(configured, "utf8"))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function engramBaseUrl(): string {
  const explicit = process.env.ENGRAM_URL
  if (explicit) return explicit.replace(/\/$/, "")
  const configured = runtimeConfig().engram_url
  if (typeof configured === "string" && configured.trim()) return configured.trim().replace(/\/$/, "")
  const port = Number.parseInt(process.env.ENGRAM_PORT ?? "7437", 10)
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 7437}`
}

function engramIsLocal(): boolean {
  try {
    const hostname = new URL(engramBaseUrl()).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  } catch {
    return false
  }
}

function pathJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/\/$/, "")
}

function topicFor(changeId: string): string {
  // Engram's portable topic convention is family/name (two levels).
  return `workflow/${changeId}`
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function engramFetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`${engramBaseUrl()}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000),
  })
  const text = await response.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  if (!response.ok) {
    throw new Error(`Engram ${options.method ?? "GET"} ${path} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`)
  }
  return body
}

async function ensureEngram(): Promise<void> {
  const baseUrl = engramBaseUrl()
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(350) })
    if (health.ok) return
  } catch {}

  if (!engramIsLocal()) throw new Error(`Engram is not reachable at ${baseUrl}`)
  const binary = process.env.ENGRAM_BIN ?? Bun.which("engram")
  if (!binary) throw new Error("Engram is not available; install it or set ENGRAM_BIN")
  Bun.spawn([binary, "serve"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(150)
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(350) })
      if (health.ok) return
    } catch {}
  }
  throw new Error("Engram did not become ready on the configured local port")
}

async function ensureSession(sessionID: string, project: string, directory: string): Promise<void> {
  await engramFetch("/sessions", {
    method: "POST",
    body: { id: sessionID, project, directory },
  })
}

function observationsFrom(body: any): Observation[] {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.observations)) return body.observations
  if (Array.isArray(body?.result)) return body.result
  return []
}

async function loadState(project: string, changeId: string): Promise<{ state: WorkflowState; id?: number } | null> {
  const query = new URLSearchParams({ project, scope: "project", limit: "200", sort: "created_at:desc" })
  const rows = observationsFrom(await engramFetch(`/observations?${query.toString()}`))
    .filter((row) => row.topic_key === topicFor(changeId))
    .sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")))

  for (const row of rows) {
    if (!row.content) continue
    try {
      const candidate = JSON.parse(row.content) as WorkflowState
      if (candidate.schema === WORKFLOW_SCHEMA && candidate.changeId === changeId) {
        return { state: candidate, id: typeof row.id === "number" ? row.id : undefined }
      }
    } catch {}
  }
  return null
}

async function persistState(
  project: string,
  sessionID: string,
  state: WorkflowState,
  observationID?: number,
): Promise<{ id?: number }> {
  const content = JSON.stringify(state)
  if (observationID !== undefined) {
    const body = await engramFetch(`/observations/${observationID}`, {
      method: "PATCH",
      body: { title: `Workflow ${state.changeId}`, content, type: "config", scope: "project", topic_key: topicFor(state.changeId) },
    })
    return { id: typeof body?.id === "number" ? body.id : observationID }
  }

  const body = await engramFetch("/observations", {
    method: "POST",
    body: {
      session_id: sessionID,
      type: "config",
      title: `Workflow ${state.changeId}`,
      content,
      project,
      scope: "project",
      topic_key: topicFor(state.changeId),
      tool_name: "workflow_state",
    },
  })
  return { id: typeof body?.id === "number" ? body.id : undefined }
}

async function lockPath(project: string, changeId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${project}\0${changeId}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return pathJoin(stateRoot(), "locks", `${hex}.lock`)
}

async function withChangeLock<T>(project: string, changeId: string, operation: () => Promise<T>): Promise<T> {
  const path = await lockPath(project, changeId)
  const lockRoot = pathJoin(stateRoot(), "locks")
  Bun.spawnSync(["mkdir", "-p", lockRoot])

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const acquired = Bun.spawnSync(["mkdir", path]).exitCode === 0
    if (acquired) {
      await Bun.write(pathJoin(path, "owner.json"), JSON.stringify({ at: now() }))
      try {
        return await operation()
      } finally {
        Bun.spawnSync(["rm", "-f", pathJoin(path, "owner.json")])
        Bun.spawnSync(["rmdir", path])
      }
    }

    const stat = Bun.spawnSync(["stat", "-c", "%Y", path])
    const modifiedSeconds = Number.parseInt(stat.stdout.toString().trim(), 10)
    if (Number.isFinite(modifiedSeconds) && Date.now() - modifiedSeconds * 1000 > LOCK_STALE_MS) {
      Bun.spawnSync(["rm", "-f", pathJoin(path, "owner.json")])
      Bun.spawnSync(["rmdir", path])
      continue
    }
    await sleep(LOCK_WAIT_MS)
  }
  throw new Error("Another workflow session currently owns this change lock")
}

function requireLead(agent: string, operation: string): void {
  if (agent !== WORKFLOW_AGENT) {
    throw new Error(`${operation} is reserved for ${WORKFLOW_AGENT}; current agent is ${agent}`)
  }
}

function requireExpected(state: WorkflowState, expected: number | undefined): void {
  if (expected === undefined) throw new Error(`expected_version is required; current version is ${state.version}`)
  if (expected !== state.version) {
    throw new Error(`workflow version conflict: expected ${expected}, current ${state.version}; reload status before retrying`)
  }
}

function leaseActive(owner: Owner): boolean {
  return Date.parse(owner.leaseUntil) > Date.now()
}

function ensureOwner(state: WorkflowState, sessionID: string): void {
  if (state.owner.sessionID !== sessionID) throw new Error(`change is owned by session ${state.owner.sessionID}`)
  if (!leaseActive(state.owner)) throw new Error("workflow lease expired; run recover before mutating it")
}

function transitionAllowed(from: Phase, to: Phase): boolean {
  const allowed: Record<Phase, Phase[]> = {
    discovery: ["planning", "verification"],
    planning: ["implementation", "discovery"],
    implementation: ["verification", "planning"],
    verification: ["delivery", "implementation"],
    delivery: ["verification"],
  }
  return allowed[from].includes(to)
}

function event(
  state: WorkflowState,
  name: string,
  summary: string,
  agent: string,
  sessionID: string,
): WorkflowState {
  const timestamp = now()
  const version = state.version + 1
  const history = [...state.history, { version, event: name, summary, actor: agent, sessionID, at: timestamp }].slice(-100)
  const owner = { ...state.owner, lastSeenAt: timestamp, leaseUntil: new Date(Date.now() + DEFAULT_LEASE_MS).toISOString() }
  return { ...state, version, updatedAt: timestamp, owner, history }
}

function result(state: WorkflowState, message: string): { title: string; output: string; metadata: Record<string, unknown> } {
  return { title: `workflow ${state.changeId} v${state.version}`, output: `${message}\n\n${JSON.stringify(state, null, 2)}`, metadata: { changeId: state.changeId, version: state.version, phase: state.phase, status: state.status } }
}

export default tool({
  description: "Manage the selectable OpenCode workflow state persisted in Engram. Mutations require the current version and are owned by workflow-lead; ready changes can be explicitly reopened or closed from a user-confirmed session.",
  args: {
    operation: tool.schema.enum(["start", "status", "claim", "transition", "checkpoint", "consultation", "recover", "ready", "complete", "reopen", "abort"]),
    change_id: tool.schema.string().describe("Stable change identifier"),
    goal: tool.schema.string().optional().describe("Required for start"),
    acceptance_criteria: tool.schema.array(tool.schema.string()).optional(),
    phase: tool.schema.enum(PHASES).optional(),
    summary: tool.schema.string().optional(),
    next_action: tool.schema.string().optional(),
    expected_version: tool.schema.number().int().nonnegative().optional(),
    consultation_kind: tool.schema.enum(["consultation", "review"]).optional(),
    confirmation: tool.schema.enum(["explicit_user_confirmation"]).optional().describe("Required to close a ready workflow after the user explicitly confirms completion"),
  },
  async execute(args, context) {
    const changeId = safeChangeId(args.change_id)
    const project = projectFrom(context.worktree || context.directory)
    const operation = args.operation
    const summary = asText(args.summary)
    await ensureEngram()
    await ensureSession(context.sessionID, project, context.directory)

    if (operation === "status") {
      const current = await loadState(project, changeId)
      if (!current) return { title: `workflow ${changeId}`, output: JSON.stringify({ status: "not_found", project, changeId }, null, 2), metadata: { status: "not_found", changeId, project } }
      return result(current.state, "Current workflow state")
    }

    if (operation !== "consultation") requireLead(context.agent, operation)

    return withChangeLock(project, changeId, async () => {
      const current = await loadState(project, changeId)

      if (operation === "start") {
        if (current) throw new Error(`change ${changeId} already exists at version ${current.state.version}`)
        const goalText = asText(args.goal)
        if (!goalText) throw new Error("goal is required for start")
        const timestamp = now()
        const state: WorkflowState = {
          schema: WORKFLOW_SCHEMA,
          changeId,
          project,
          worktree: context.worktree,
          goal: goalText,
          acceptanceCriteria: (args.acceptance_criteria ?? []).map(asText).filter(Boolean),
          phase: "discovery",
          status: "active",
          version: 1,
          owner: { agent: WORKFLOW_AGENT, sessionID: context.sessionID, claimedAt: timestamp, lastSeenAt: timestamp, leaseUntil: new Date(Date.now() + DEFAULT_LEASE_MS).toISOString() },
          nextAction: asText(args.next_action) || "Inspect the project and define the implementation boundary",
          updatedAt: timestamp,
          history: [{ version: 1, event: "started", summary: goalText, actor: context.agent, sessionID: context.sessionID, at: timestamp }],
          consultations: [],
        }
        const saved = await persistState(project, context.sessionID, state)
        const readback = await loadState(project, changeId)
        if (!readback || readback.state.version !== state.version) throw new Error("Engram readback did not confirm the started workflow")
        return result({ ...state }, `Started workflow ${changeId} (observation ${saved.id ?? "unknown"})`)
      }

      if (!current) throw new Error(`change ${changeId} does not exist; run operation=start first`)
      let state = current.state

      if (operation === "claim" || operation === "recover") {
        requireExpected(state, args.expected_version)
        if (state.status === "completed" || state.status === "aborted") throw new Error(`cannot claim a terminal workflow (${state.status})`)
        if (state.owner.sessionID !== context.sessionID && leaseActive(state.owner) && operation === "claim") {
          throw new Error(`workflow is still leased by session ${state.owner.sessionID}; use recover after the lease expires`)
        }
        state = event(state, operation === "recover" ? "recovered" : "claimed", summary || `${operation} by ${context.sessionID}`, context.agent, context.sessionID)
        state.owner = { ...state.owner, agent: WORKFLOW_AGENT, sessionID: context.sessionID, claimedAt: state.owner.claimedAt || now() }
      } else if (operation === "consultation") {
        requireExpected(state, args.expected_version)
        const kind = args.consultation_kind ?? "consultation"
        state = event(state, kind, summary || `${kind} recorded`, context.agent, context.sessionID)
        state.consultations = [...state.consultations, { kind, actor: context.agent, sessionID: context.sessionID, summary: summary || `${kind} recorded`, at: state.updatedAt }].slice(-100)
      } else if (operation === "ready") {
        requireExpected(state, args.expected_version)
        ensureOwner(state, context.sessionID)
        if (state.status !== "active") throw new Error(`workflow must be active before requesting completion (current status: ${state.status})`)
        if (state.phase !== "verification" && state.phase !== "delivery") throw new Error(`workflow must be in verification or delivery before requesting completion (current phase: ${state.phase})`)
        state = event(state, "ready_for_confirmation", summary || "Implementation is ready; waiting for explicit user confirmation", context.agent, context.sessionID)
        state.status = "ready"
        state.phase = "delivery"
        state.nextAction = asText(args.next_action) || "Await explicit user confirmation before completing this change"
      } else if (operation === "reopen") {
        requireExpected(state, args.expected_version)
        if (state.status !== "ready") throw new Error(`only a ready workflow can be reopened (current status: ${state.status})`)
        state.owner = { ...state.owner, agent: WORKFLOW_AGENT, sessionID: context.sessionID, claimedAt: state.owner.claimedAt || now() }
        state = event(state, "reopened", summary || "User requested another adjustment before completion", context.agent, context.sessionID)
        state.status = "active"
        state.phase = "verification"
        state.nextAction = asText(args.next_action) || "Re-evaluate the requested adjustment and continue the existing change"
      } else {
        requireExpected(state, args.expected_version)
        if (operation === "complete" && state.status === "ready") {
          if (args.confirmation !== "explicit_user_confirmation") throw new Error("explicit user confirmation is required before completing this workflow")
          state.owner = { ...state.owner, agent: WORKFLOW_AGENT, sessionID: context.sessionID, claimedAt: state.owner.claimedAt || now() }
        } else {
          ensureOwner(state, context.sessionID)
        }
        if (state.status === "completed" || state.status === "aborted") throw new Error(`cannot mutate a terminal workflow (${state.status})`)
        const nextAction = asText(args.next_action)
        if (operation === "transition") {
          if (!args.phase || !transitionAllowed(state.phase, args.phase)) throw new Error(`invalid phase transition ${state.phase} -> ${args.phase ?? "(missing)"}`)
          state = event(state, `phase:${args.phase}`, summary || `Transitioned to ${args.phase}`, context.agent, context.sessionID)
          state.phase = args.phase
          if (nextAction) state.nextAction = nextAction
        } else if (operation === "checkpoint") {
          state = event(state, "checkpoint", summary || "Checkpoint", context.agent, context.sessionID)
          if (nextAction) state.nextAction = nextAction
        } else if (operation === "complete") {
          if (state.status !== "ready") throw new Error(`workflow must be ready and explicitly confirmed before completion (current status: ${state.status})`)
          if (args.confirmation !== "explicit_user_confirmation") throw new Error("explicit user confirmation is required before completing this workflow")
          state = event(state, "completed", summary || "Completed", context.agent, context.sessionID)
          state.status = "completed"
          state.phase = "delivery"
          state.nextAction = nextAction || "No further action"
        } else if (operation === "abort") {
          state = event(state, "aborted", summary || "Aborted", context.agent, context.sessionID)
          state.status = "aborted"
          state.nextAction = nextAction || "Investigate the abort reason before restarting"
        }
      }

      await persistState(project, context.sessionID, state, current.id)
      const readback = await loadState(project, changeId)
      if (!readback || readback.state.version !== state.version || readback.state.status !== state.status) {
        throw new Error("Engram readback disagrees with the committed workflow state")
      }
      return result(state, `Applied ${operation} to ${changeId}`)
    })
  },
})
