import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import {
  DELIVERY_STRATEGIES,
  PHASES,
  VERIFICATION_TIERS,
  WORKFLOW_SCHEMA,
  currentBranch,
  expectedContractPath,
  implementationGateErrors,
  isProtectedBranch,
  normalizeWorkflowState,
  readyGateErrors,
  treeFingerprint,
  type WorkflowMode,
  type Capability,
  type Finding,
  type Owner,
  type Phase,
  type WorkflowState,
} from "../continuous-workflow/runtime.ts"

const WORKFLOW_AGENT = "workflow-lead"
const WORKFLOW_AGENT_PREFIX = "workflow-lead-"
const DEFAULT_LEASE_MS = 30 * 60 * 1000
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 2 * DEFAULT_LEASE_MS

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

function pathJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "")
}

function commandSync(command: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    return {
      exitCode: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: String(error) }
  }
}

function executablePath(command: string): string | undefined {
  if (command.includes("/")) {
    try {
      accessSync(command, fsConstants.X_OK)
      return command
    } catch {
      return undefined
    }
  }
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue
    const candidate = pathJoin(directory, command)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

function safeChangeId(value: string): string {
  const changeId = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(changeId)) {
    throw new Error("change_id must use 1-120 letters, numbers, dots, underscores, or hyphens")
  }
  return changeId
}

function projectFrom(directory: string): string {
  const remote = commandSync("git", ["-C", directory, "remote", "get-url", "origin"])
  if (remote.exitCode === 0) {
    const value = remote.stdout.trim().replace(/\.git$/, "")
    const name = value.split(/[/:]/).pop()
    if (name) return name
  }
  const root = commandSync("git", ["-C", directory, "rev-parse", "--show-toplevel"])
  if (root.exitCode === 0) {
    const name = root.stdout.trim().split("/").pop()
    if (name) return name
  }
  return directory.split("/").filter(Boolean).pop() ?? "unknown-project"
}

function stateRoot(): string {
  if (process.env.CONTINUOUS_WORKFLOW_STATE_DIR) return process.env.CONTINUOUS_WORKFLOW_STATE_DIR
  return pathJoin(process.env.HOME ?? "/tmp", ".local", "share", "opencode", "continuous-workflow")
}

function runtimeConfig(): Record<string, unknown> {
  const configured = process.env.CONTINUOUS_WORKFLOW_CONFIG ?? pathJoin(process.env.HOME ?? "/tmp", ".config", "opencode", "continuous-workflow", "config.json")
  try {
    const parsed = JSON.parse(readFileSync(configured, "utf8"))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function engramBaseUrl(): string {
  if (process.env.ENGRAM_URL) return process.env.ENGRAM_URL.replace(/\/$/, "")
  const configured = runtimeConfig().engram_url
  if (typeof configured === "string" && configured.trim()) return configured.trim().replace(/\/$/, "")
  const port = Number.parseInt(process.env.ENGRAM_PORT ?? "7437", 10)
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 7437}`
}

function engramIsLocal(): boolean {
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(engramBaseUrl()).hostname)
  } catch {
    return false
  }
}

function topicFor(changeId: string): string {
  return `workflow/${changeId}`
}

function stateMirrorPath(project: string, changeId: string): string {
  const digest = createHash("sha256").update(`${project}\0${changeId}`).digest("hex")
  return pathJoin(stateRoot(), "states", `${digest}.json`)
}

function mirrorState(state: WorkflowState): void {
  try {
    const path = stateMirrorPath(state.project, state.changeId)
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, JSON.stringify(state), "utf8")
  } catch {}
}

function mirroredState(project: string, changeId: string): WorkflowState | null {
  try {
    const state = normalizeWorkflowState(JSON.parse(readFileSync(stateMirrorPath(project, changeId), "utf8")))
    return state?.project === project && state.changeId === changeId ? state : null
  } catch {
    return null
  }
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
  try { body = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) throw new Error(`Engram ${options.method ?? "GET"} ${path} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`)
  return body
}

async function ensureEngram(): Promise<void> {
  const baseUrl = engramBaseUrl()
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(350) })
    if (health.ok) return
  } catch {}
  if (!engramIsLocal()) throw new Error(`Engram is not reachable at ${baseUrl}`)
  const binary = process.env.ENGRAM_BIN ?? executablePath("engram")
  if (!binary) throw new Error("Engram is not available; install it or set ENGRAM_BIN")
  const child = spawn(binary, ["serve"], { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
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
  await engramFetch("/sessions", { method: "POST", body: { id: sessionID, project, directory } })
}

function observationsFrom(body: any): Observation[] {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.observations)) return body.observations
  if (Array.isArray(body?.result)) return body.result
  return []
}

async function loadState(project: string, changeId: string): Promise<{ state: WorkflowState; id?: number; migrated: boolean } | null> {
  const query = new URLSearchParams({ project, scope: "project", limit: "200", sort: "created_at:desc" })
  const rows = observationsFrom(await engramFetch(`/observations?${query.toString()}`))
    .filter((row) => row.topic_key === topicFor(changeId))
  const candidates: { state: WorkflowState; id?: number; migrated: boolean; at: number }[] = []
  for (const row of rows) {
    if (!row.content) continue
    try {
      const raw = JSON.parse(row.content)
      const state = normalizeWorkflowState(raw)
      if (state?.project === project && state.changeId === changeId) {
        const stateAt = Date.parse(state.updatedAt)
        const rowAt = Date.parse(String(row.updated_at ?? row.created_at ?? ""))
        candidates.push({ state, id: typeof row.id === "number" ? row.id : undefined, migrated: raw.schema !== WORKFLOW_SCHEMA, at: Number.isFinite(stateAt) ? stateAt : Number.isFinite(rowAt) ? rowAt : 0 })
      }
    } catch {}
  }
  const local = mirroredState(project, changeId)
  if (local) {
    const stateAt = Date.parse(local.updatedAt)
    candidates.push({ state: local, migrated: false, at: Number.isFinite(stateAt) ? stateAt : 0 })
  }
  candidates.sort((a, b) => b.at - a.at)
  if (candidates[0]) return candidates[0]
  return null
}

async function persistState(project: string, sessionID: string, state: WorkflowState, observationID?: number): Promise<{ id?: number }> {
  const content = JSON.stringify(state)
  if (observationID !== undefined) {
    const body = await engramFetch(`/observations/${observationID}`, {
      method: "PATCH",
      body: { title: `Workflow ${state.changeId}`, content, type: "config", scope: "project", topic_key: topicFor(state.changeId) },
    })
    mirrorState(state)
    return { id: typeof body?.id === "number" ? body.id : observationID }
  }
  const body = await engramFetch("/observations", {
    method: "POST",
    body: { session_id: sessionID, type: "config", title: `Workflow ${state.changeId}`, content, project, scope: "project", topic_key: topicFor(state.changeId), tool_name: "workflow_state" },
  })
  mirrorState(state)
  return { id: typeof body?.id === "number" ? body.id : undefined }
}

async function lockPath(project: string, changeId: string): Promise<string> {
  const digest = createHash("sha256").update(`${project}\0${changeId}`).digest("hex")
  return pathJoin(stateRoot(), "locks", `${digest}.lock`)
}

async function withChangeLock<T>(project: string, changeId: string, operation: () => Promise<T>): Promise<T> {
  const path = await lockPath(project, changeId)
  mkdirSync(pathJoin(stateRoot(), "locks"), { recursive: true })
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let acquired = false
    try { mkdirSync(path); acquired = true } catch {}
    if (acquired) {
      writeFileSync(pathJoin(path, "owner.json"), JSON.stringify({ at: now() }))
      try { return await operation() } finally {
        try { unlinkSync(pathJoin(path, "owner.json")) } catch {}
        try { rmdirSync(path) } catch {}
      }
    }
    let modifiedMs = 0
    try { modifiedMs = statSync(path).mtimeMs } catch {}
    if (modifiedMs > 0 && Date.now() - modifiedMs > LOCK_STALE_MS) {
      try { unlinkSync(pathJoin(path, "owner.json")) } catch {}
      try { rmdirSync(path) } catch {}
      continue
    }
    await sleep(LOCK_WAIT_MS)
  }
  throw new Error("Another workflow session currently owns this change lock")
}

function isLeadAgent(agent: string): boolean {
  return agent === WORKFLOW_AGENT || agent.startsWith(WORKFLOW_AGENT_PREFIX)
}

function requireLead(agent: string, operation: string): void {
  if (!isLeadAgent(agent)) throw new Error(`${operation} is reserved for workflow-lead; current agent is ${agent}`)
}

function profileFromAgent(agent: string): string {
  return agent === WORKFLOW_AGENT ? "default" : agent.startsWith(WORKFLOW_AGENT_PREFIX) ? agent.slice(WORKFLOW_AGENT_PREFIX.length) || "default" : "default"
}

function requireExpected(state: WorkflowState, expected: number | undefined): void {
  if (expected === undefined) throw new Error(`expected_version is required; current version is ${state.version}`)
  if (expected !== state.version) throw new Error(`workflow version conflict: expected ${expected}, current ${state.version}; reload status before retrying`)
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
    discovery: ["planning"],
    planning: ["implementation", "discovery"],
    implementation: ["verification", "planning"],
    verification: ["review", "delivery", "implementation", "planning"],
    review: ["implementation", "verification", "delivery", "planning"],
    delivery: ["verification", "planning"],
  }
  return allowed[from].includes(to)
}

function assessmentTransitionAllowed(state: WorkflowState, to: Phase): boolean {
  return state.mode === "assessment" && state.phase === "planning" && to === "verification"
}

function event(state: WorkflowState, name: string, summary: string, agent: string, sessionID: string): WorkflowState {
  const timestamp = now()
  const version = state.version + 1
  const history = [...state.history, { version, event: name, summary, actor: agent, sessionID, at: timestamp }].slice(-100)
  const owner = { ...state.owner, agent, lastSeenAt: timestamp, leaseUntil: new Date(Date.now() + DEFAULT_LEASE_MS).toISOString() }
  return { ...state, version, updatedAt: timestamp, owner, profile: profileFromAgent(agent), history }
}

function isCorrectionLoop(state: WorkflowState): boolean {
  const implementationStart = state.history.map((entry) => entry.event).lastIndexOf("mode:implementation")
  let passedVerification = false
  for (const entry of state.history.slice(implementationStart + 1)) {
    if (entry.event === "verification_passed" || entry.event === "review_blocked" || entry.event === "phase:verification") passedVerification = true
    if (passedVerification && entry.event === "phase:implementation") return true
  }
  return false
}

function statusView(state: WorkflowState): WorkflowState {
  if (state.mode !== "implementation" || state.phase !== "verification" || !isCorrectionLoop(state)) return state
  return {
    ...state,
    nextAction: "Record verification with only the checks affected by the correction; leave the complete suite to CI, then launch the independent reviewer",
  }
}

function result(state: WorkflowState, message: string): { title: string; output: string; metadata: Record<string, unknown> } {
  return {
    title: `workflow ${state.changeId} v${state.version}`,
    output: `${message}\n\n${JSON.stringify(state, null, 2)}`,
    metadata: { changeId: state.changeId, version: state.version, phase: state.phase, status: state.status, schema: state.schema, profile: state.profile ?? "default" },
  }
}

function actualContractHash(worktree: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) throw new Error("contract_path must be a project-relative path")
  try { return createHash("sha256").update(readFileSync(pathJoin(worktree, relativePath))).digest("hex") } catch {
    throw new Error(`contract file does not exist or cannot be read: ${relativePath}`)
  }
}

function requireNonTerminal(state: WorkflowState): void {
  if (state.status === "completed" || state.status === "aborted") throw new Error(`cannot mutate a terminal workflow (${state.status})`)
}

const capabilitySchema = tool.schema.object({
  id: tool.schema.string(),
  behavior: tool.schema.string(),
  kind: tool.schema.enum(["current", "future", "non-goal"]),
  status: tool.schema.enum(["pending", "verified", "preserved", "excluded"]),
  evidence: tool.schema.string().optional(),
})

const findingSchema = tool.schema.object({
  id: tool.schema.string(),
  severity: tool.schema.string(),
  category: tool.schema.string(),
  location: tool.schema.string(),
  evidence: tool.schema.string(),
  impact: tool.schema.string(),
  correction: tool.schema.string(),
})

export default tool({
  description: "Manage Continuous Workflow v2 assessment and implementation tracks. Contract, evidence, delivery, verification, review, recovery, and completion gates are typed and enforced; only workflow-lead may mutate canonical state.",
  args: {
    operation: tool.schema.enum(["start", "status", "claim", "recover", "mode_set", "delivery_prepare", "contract_draft", "contract_approve", "contract_metadata_reconcile", "capabilities_record", "capabilities_evidence", "brief_present", "verification_plan", "transition", "checkpoint", "consultation", "verification_record", "review_record", "post_ci", "ci_status", "manual_confirm", "ready", "complete", "reopen", "abort"]),
    change_id: tool.schema.string().describe("Stable change identifier"),
    goal: tool.schema.string().optional(),
    acceptance_criteria: tool.schema.array(tool.schema.string()).optional(),
    workflow_mode: tool.schema.enum(["implementation", "assessment"]).optional(),
    phase: tool.schema.enum(PHASES).optional(),
    summary: tool.schema.string().optional(),
    next_action: tool.schema.string().optional(),
    expected_version: tool.schema.number().int().nonnegative().optional(),
    contract_path: tool.schema.string().optional(),
    contract_version: tool.schema.number().int().positive().optional(),
    contract_hash: tool.schema.string().optional(),
    brief_summary: tool.schema.string().optional(),
    delivery_strategy: tool.schema.enum(DELIVERY_STRATEGIES).optional(),
    branch: tool.schema.string().optional(),
    base_branch: tool.schema.string().optional(),
    capabilities: tool.schema.array(capabilitySchema).optional(),
    verification_tier: tool.schema.enum(VERIFICATION_TIERS).optional(),
    verification_reason: tool.schema.string().optional(),
    verification_required_checks: tool.schema.array(tool.schema.string()).optional(),
    verification_manual_checks: tool.schema.array(tool.schema.string()).optional(),
    verification_artifact_paths: tool.schema.array(tool.schema.string()).optional(),
    verification_evidence: tool.schema.array(tool.schema.string()).optional(),
    review_outcome: tool.schema.enum(["passed", "blocked"]).optional(),
    ci_outcome: tool.schema.enum(["passed", "failed"]).optional(),
    findings: tool.schema.array(findingSchema).optional(),
    consultation_kind: tool.schema.enum(["consultation", "review"]).optional(),
    confirmation: tool.schema.enum(["explicit_user_contract_approval", "explicit_user_confirmation", "explicit_user_manual_review"]).optional(),
  },
  async execute(args, context) {
    const changeId = safeChangeId(args.change_id)
    const worktree = context.worktree || context.directory
    const project = projectFrom(worktree)
    const operation = args.operation
    const summary = asText(args.summary)

    if (operation === "status") {
      try {
        await ensureEngram()
        await ensureSession(context.sessionID, project, context.directory)
        const current = await loadState(project, changeId)
        if (!current) return { title: `workflow ${changeId}`, output: JSON.stringify({ status: "not_found", project, changeId }, null, 2), metadata: { status: "not_found", changeId, project } }
        mirrorState(current.state)
        return result(statusView(current.state), current.migrated ? "Current workflow state (legacy v1 loaded as v2; next mutation will persist the migration)" : "Current workflow state")
      } catch (error) {
        const local = mirroredState(project, changeId)
        if (!local) throw error
        return result(statusView(local), "Current workflow state (local durable mirror; Engram was unavailable)")
      }
    }

    await ensureEngram()
    await ensureSession(context.sessionID, project, context.directory)
    requireLead(context.agent, operation)
    return withChangeLock(project, changeId, async () => {
      const current = await loadState(project, changeId)
      if (operation === "start") {
        if (current) throw new Error(`change ${changeId} already exists at version ${current.state.version}`)
        let contractExists = false
        try { contractExists = statSync(pathJoin(worktree, expectedContractPath(changeId))).isFile() } catch {}
        if (contractExists) throw new Error(`change ${changeId} has an existing contract but no durable workflow state; do not start a replacement, recover or inspect the same project/worktree first`)
        const goal = asText(args.goal)
        if (!goal) throw new Error("goal is required for start")
        const workflowMode = args.workflow_mode as WorkflowMode | undefined
        if (!workflowMode) throw new Error("workflow_mode is required for start: choose assessment or implementation")
        const timestamp = now()
        const state: WorkflowState = {
          schema: WORKFLOW_SCHEMA,
          changeId,
          project,
          worktree,
          goal,
          acceptanceCriteria: (args.acceptance_criteria ?? []).map(asText).filter(Boolean),
          mode: workflowMode,
          phase: "discovery",
          status: "active",
          profile: profileFromAgent(context.agent),
          version: 1,
          owner: { agent: context.agent, sessionID: context.sessionID, claimedAt: timestamp, lastSeenAt: timestamp, leaseUntil: new Date(Date.now() + DEFAULT_LEASE_MS).toISOString() },
          nextAction: asText(args.next_action) || (workflowMode === "assessment"
            ? "Delegate read-only discovery, then draft the functional assessment contract"
            : "Prepare a non-protected delivery branch, then draft the functional contract"),
          updatedAt: timestamp,
          history: [{ version: 1, event: "started", summary: goal, actor: context.agent, sessionID: context.sessionID, at: timestamp }],
          consultations: [],
          contract: { path: expectedContractPath(changeId), version: 0, hash: "", status: "missing" },
          implementationBrief: { status: "missing", contractHash: "", summary: "" },
          delivery: { status: "missing", branch: "", baseBranch: "", worktree },
          capabilities: [],
          verificationPlan: { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] },
          verification: { status: "missing", treeFingerprint: "", evidence: [] },
          review: { status: "missing", treeFingerprint: "", findings: [], summary: "" },
          ci: { status: "pending", treeFingerprint: "" },
          manualReview: { status: "pending" },
        }
        const saved = await persistState(project, context.sessionID, state)
        return result(state, `Started workflow ${changeId} (observation ${saved.id ?? "unknown"})`)
      }

      if (!current) throw new Error(`change ${changeId} has no durable state for project ${project} in worktree ${worktree}; verify the same project/worktree before starting a replacement`)
      let state = current.state
      requireExpected(state, args.expected_version)

      if (operation === "claim" || operation === "recover") {
        requireNonTerminal(state)
        if (state.owner.sessionID !== context.sessionID && leaseActive(state.owner) && operation === "claim") throw new Error(`workflow is still leased by session ${state.owner.sessionID}; use recover after the lease expires`)
        state = event(state, operation === "recover" ? "recovered" : "claimed", summary || `${operation} by ${context.sessionID}`, context.agent, context.sessionID)
        state.owner = { ...state.owner, sessionID: context.sessionID, claimedAt: state.owner.claimedAt || now() }
      } else {
        if (operation === "complete" && state.status === "ready") {
          if (args.confirmation !== "explicit_user_confirmation") throw new Error("explicit user confirmation is required before completing this workflow")
          state.owner = { ...state.owner, sessionID: context.sessionID }
        } else {
          ensureOwner(state, context.sessionID)
        }
        requireNonTerminal(state)
        const nextAction = asText(args.next_action)

        if (operation === "mode_set") {
          const targetMode = args.workflow_mode as WorkflowMode | undefined
          if (!targetMode) throw new Error("workflow_mode is required for mode_set")
          if (!summary) throw new Error("summary is required for mode_set and must identify the user's decision")
          if (targetMode === state.mode) throw new Error(`workflow is already in ${targetMode} mode`)
          if (targetMode === "assessment") {
            if (state.phase !== "discovery" && state.phase !== "planning") throw new Error("assessment mode can only be selected before implementation starts")
            if (state.implementationBrief.status === "presented") throw new Error("assessment mode cannot replace an implementation brief that has already been presented")
            state = event(state, "mode:assessment", summary, context.agent, context.sessionID)
            state.mode = "assessment"
            state.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] }
            state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
            state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
            state.nextAction = nextAction || "Complete read-only discovery and present the functional assessment contract"
          } else {
            if (state.mode !== "assessment") throw new Error("implementation mode can only be entered from assessment mode")
            if (state.contract.status !== "approved") throw new Error("approve the assessment contract before entering implementation mode")
            if (state.phase === "discovery") throw new Error("finish the investigation and assessment contract before entering implementation mode")
            state = event(state, "mode:implementation", summary, context.agent, context.sessionID)
            state.mode = "implementation"
            state.status = "active"
            state.phase = "planning"
            state.implementationBrief = { status: "missing", contractHash: "", summary: "" }
            state.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] }
            state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
            state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
            state.nextAction = nextAction || "Prepare a non-protected delivery branch, present the implementation brief, and record the verification plan"
          }
        } else if (operation === "delivery_prepare") {
          if (state.mode === "assessment") throw new Error("assessment mode does not require delivery preparation; record its read-only verification plan instead")
          const branch = asText(args.branch) || currentBranch(worktree)
          const actualBranch = currentBranch(worktree)
          if (!args.delivery_strategy) throw new Error("delivery_strategy is required")
          if (!branch || branch !== actualBranch) throw new Error(`prepared branch must equal current branch (${actualBranch || "unresolved"})`)
          if (isProtectedBranch(branch)) throw new Error(`protected branch ${branch} cannot be used for implementation`)
          state = event(state, "delivery_prepared", summary || `${args.delivery_strategy} on ${branch}`, context.agent, context.sessionID)
          state.delivery = { status: "prepared", strategy: args.delivery_strategy, branch, baseBranch: asText(args.base_branch) || "main", worktree, preparedAt: state.updatedAt }
          state.worktree = worktree
          state.nextAction = nextAction || `Draft ${expectedContractPath(changeId)}`
        } else if (operation === "contract_draft") {
          const branch = currentBranch(worktree)
          if (state.mode !== "assessment" && (state.delivery.status !== "prepared" || state.delivery.worktree !== worktree || state.delivery.branch !== branch || isProtectedBranch(branch))) {
            throw new Error("prepare and record a non-protected delivery branch/worktree before drafting the functional contract")
          }
          const path = asText(args.contract_path) || expectedContractPath(changeId)
          if (path !== expectedContractPath(changeId)) throw new Error(`contract_path must be exactly ${expectedContractPath(changeId)}`)
          const version = args.contract_version ?? 0
          if (version < 1) throw new Error("contract_version must be at least 1")
          const actualHash = actualContractHash(worktree, path)
          if (asText(args.contract_hash) && asText(args.contract_hash) !== actualHash) throw new Error("contract_hash does not match the contract file")
          state = event(state, "contract_drafted", summary || `Contract v${version} drafted`, context.agent, context.sessionID)
          state.contract = { path, version, hash: actualHash, status: "draft" }
          state.implementationBrief = { status: "missing", contractHash: "", summary: "" }
          state.capabilities = []
          state.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] }
          state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
          state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          state.nextAction = nextAction || "Present the complete functional contract and wait for explicit approval"
        } else if (operation === "contract_approve") {
          if (args.confirmation !== "explicit_user_contract_approval") throw new Error("explicit_user_contract_approval confirmation is required")
          if (state.contract.status !== "draft") throw new Error("only a drafted contract can be approved")
          const actualHash = actualContractHash(worktree, state.contract.path)
          if (actualHash !== state.contract.hash || asText(args.contract_hash) !== actualHash) throw new Error("approval must reference the exact current contract hash")
          if (!summary) throw new Error("summary must identify the user's explicit approval evidence")
          state = event(state, "contract_approved", summary, context.agent, context.sessionID)
          state.contract = { ...state.contract, status: "approved", approvedAt: state.updatedAt, approvalSessionID: context.sessionID, approvalEvidence: summary }
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Record the capability matrix, complete the investigation, and prepare the assessment verification"
            : "Record the capability matrix and obtain any required technical consultations")
        } else if (operation === "contract_metadata_reconcile") {
          if (args.confirmation !== "explicit_user_contract_approval") throw new Error("explicit_user_contract_approval confirmation is required")
          if (state.contract.status !== "approved") throw new Error("administrative reconciliation requires an already approved contract")
          if (state.phase !== "verification" && state.phase !== "delivery") throw new Error("administrative reconciliation is allowed only after implementation, during verification or delivery")
          const actualHash = actualContractHash(worktree, state.contract.path)
          if (!asText(args.contract_hash) || asText(args.contract_hash) !== actualHash) throw new Error("administrative reconciliation must reference the exact current contract hash")
          if (!summary) throw new Error("summary must describe the administrative correction and user confirmation")
          state = event(state, "contract_metadata_reconciled", summary, context.agent, context.sessionID)
          state.contract = { ...state.contract, version: state.contract.version + 1, hash: actualHash, status: "approved", approvedAt: state.updatedAt, approvalSessionID: context.sessionID, approvalEvidence: summary }
          state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Continue the existing read-only assessment evidence; do not restart discovery or run an implementation review"
            : "Launch a fresh independent review against the reconciled approved contract and current verified tree")
        } else if (operation === "capabilities_record") {
          if (state.contract.status !== "approved") throw new Error("approve the contract before recording capabilities")
          const capabilities = (args.capabilities ?? []) as Capability[]
          if (capabilities.length === 0) throw new Error("capabilities must contain at least one observable contract item")
          const ids = new Set<string>()
          for (const capability of capabilities) {
            if (!asText(capability.id) || !asText(capability.behavior)) throw new Error("every capability needs id and behavior")
            if (ids.has(capability.id)) throw new Error(`duplicate capability id: ${capability.id}`)
            ids.add(capability.id)
          }
          state = event(state, "capabilities_recorded", summary || `${capabilities.length} contract capabilities recorded`, context.agent, context.sessionID)
          state.capabilities = capabilities
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Consult specialists as needed, complete the read-only assessment, and record its verification plan"
            : "Consult specialists when needed, reconcile their findings, and present the implementation brief")
        } else if (operation === "capabilities_evidence") {
          if (state.phase !== "verification" && state.phase !== "delivery") throw new Error("capability evidence can only be recorded in verification or delivery phase")
          const evidence = (args.capabilities ?? []) as Capability[]
          if (state.capabilities.length === 0) throw new Error("record the capability matrix before recording evidence")
          if (evidence.length !== state.capabilities.length) throw new Error("capability evidence must cover every recorded capability exactly once")
          const priorById = new Map(state.capabilities.map((capability) => [capability.id, capability]))
          const seen = new Set<string>()
          for (const capability of evidence) {
            const prior = priorById.get(capability.id)
            if (!prior || seen.has(capability.id)) throw new Error("capability evidence must use each existing capability ID exactly once")
            seen.add(capability.id)
            if (capability.kind !== prior.kind || capability.behavior !== prior.behavior) throw new Error(`capability evidence cannot change scope for ${capability.id}`)
            if (!asText(capability.evidence)) throw new Error(`capability evidence is required for ${capability.id}`)
            if (capability.kind === "current" && capability.status !== "verified") throw new Error(`current capability ${capability.id} must be verified or the change remains blocked`)
            if (capability.kind === "future" && capability.status !== "preserved") throw new Error(`future capability ${capability.id} must be confirmed as preserved or the change remains blocked`)
            if (capability.kind === "non-goal" && capability.status !== "excluded") throw new Error(`non-goal ${capability.id} must be confirmed as excluded or the change remains blocked`)
          }
          state = event(state, "capabilities_evidence_recorded", summary || `${evidence.length} capability evidence item(s) recorded`, context.agent, context.sessionID)
          state.capabilities = evidence
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Present the assessment recommendation and its limitations, then await the user's decision"
            : "Record or inspect independent review, then request ready when its receipt passes")
        } else if (operation === "brief_present") {
          if (state.mode === "assessment") throw new Error("assessment mode does not require an implementation brief; record its read-only verification plan instead")
          if (state.contract.status !== "approved") throw new Error("approve the contract before presenting the implementation brief")
          const brief = asText(args.brief_summary)
          if (!brief) throw new Error("brief_summary is required")
          if (state.capabilities.length === 0) throw new Error("record the capability matrix before presenting the brief")
          state = event(state, "implementation_brief_presented", summary || "Implementation brief presented to the user", context.agent, context.sessionID)
          state.implementationBrief = { status: "presented", contractHash: state.contract.hash, summary: brief, presentedAt: state.updatedAt }
          state.nextAction = nextAction || "Record the verification plan, then transition to implementation and delegate the approved package to workflow-implementer"
        } else if (operation === "verification_plan") {
          if (state.phase !== "planning" && state.phase !== "verification") throw new Error("verification plan can only be recorded in planning or verification phase")
          if (state.contract.status !== "approved") throw new Error("approve the contract before recording the verification plan")
          if (state.mode !== "assessment" && (state.implementationBrief.status !== "presented" || state.implementationBrief.contractHash !== state.contract.hash)) throw new Error("present the current implementation brief before recording the verification plan")
          const tier = args.verification_tier
          const reason = asText(args.verification_reason)
          const requiredChecks = (args.verification_required_checks ?? []).map(asText).filter(Boolean)
          const manualChecks = (args.verification_manual_checks ?? []).map(asText).filter(Boolean)
          const artifactPaths = (args.verification_artifact_paths ?? []).map(asText).filter(Boolean)
          if (artifactPaths.some((path) => path.startsWith("/") || path.includes("..") || /[*?\s]/.test(path))) throw new Error("verification_artifact_paths must be project-relative exact files or directories")
          if (!tier || !reason || requiredChecks.length === 0) throw new Error("verification_tier, verification_reason, and verification_required_checks are required")
          const previousPlan = state.verificationPlan
          const planChanged = previousPlan.status !== "planned"
            || previousPlan.tier !== tier
            || previousPlan.owner !== (state.mode === "assessment" ? "workflow-consultant" : "workflow-implementer")
            || previousPlan.reason !== reason
            || JSON.stringify(previousPlan.requiredChecks) !== JSON.stringify(requiredChecks)
            || JSON.stringify(previousPlan.manualChecks) !== JSON.stringify(manualChecks)
            || JSON.stringify(previousPlan.artifactPaths) !== JSON.stringify(artifactPaths)
          state = event(state, "verification_planned", summary || `${tier} verification planned`, context.agent, context.sessionID)
          state.verificationPlan = { status: "planned", tier, owner: state.mode === "assessment" ? "workflow-consultant" : "workflow-implementer", reason, requiredChecks, manualChecks, artifactPaths, plannedAt: state.updatedAt }
          if (planChanged) {
            state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
            state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          }
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Transition directly to verification and delegate the recorded assessment to workflow-consultant"
            : "Transition to implementation and delegate the approved package to workflow-implementer")
        } else if (operation === "consultation") {
          const kind = args.consultation_kind ?? "consultation"
          state = event(state, kind, summary || `${kind} consolidated by Lead`, context.agent, context.sessionID)
          state.consultations = [...state.consultations, { kind, actor: context.agent, sessionID: context.sessionID, summary: summary || `${kind} consolidated by Lead`, at: state.updatedAt }].slice(-100)
        } else if (operation === "transition") {
          if (!args.phase || (!transitionAllowed(state.phase, args.phase) && !assessmentTransitionAllowed(state, args.phase))) throw new Error(`invalid phase transition ${state.phase} -> ${args.phase ?? "(missing)"}`)
          if (args.phase === "planning" && state.contract.status !== "approved") throw new Error("planning requires an approved contract")
          if (args.phase === "implementation" && state.mode === "assessment") throw new Error("assessment mode cannot enter implementation directly; use mode_set after the user explicitly requests implementation")
          if (args.phase === "verification" && state.mode === "assessment" && (state.verificationPlan.status !== "planned" || state.verificationPlan.owner !== "workflow-consultant")) {
            throw new Error("assessment verification requires a planned workflow-consultant verification task")
          }
          if (args.phase === "planning" && ["implementation", "verification", "delivery"].includes(state.phase)) {
            state.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] }
            state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
            state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
            state.nextAction = nextAction || "Record a new verification plan for the next implementation candidate"
          }
          if (args.phase === "implementation") {
            const errors = implementationGateErrors(state, worktree)
            if (errors.length) throw new Error(`implementation gate failed: ${errors.join("; ")}`)
            if (state.capabilities.length === 0) throw new Error("implementation gate failed: capability matrix is empty")
            state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
            state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          }
          state = event(state, `phase:${args.phase}`, summary || `Transitioned to ${args.phase}`, context.agent, context.sessionID)
          state.phase = args.phase
          if (nextAction) state.nextAction = nextAction
          else if (args.phase === "verification" && state.mode === "implementation") {
            state.nextAction = "Inspect the implementation report and record verification evidence directly; after a correction run only affected checks and leave the complete suite to CI; delegate only explicitly missing checks, then launch the independent reviewer"
          }
        } else if (operation === "checkpoint") {
          state = event(state, "checkpoint", summary || "Checkpoint", context.agent, context.sessionID)
          if (nextAction) state.nextAction = nextAction
        } else if (operation === "verification_record") {
          if (state.phase !== "verification") throw new Error("verification can only be recorded in verification phase")
          const evidence = (args.verification_evidence ?? []).map(asText).filter(Boolean)
          if (evidence.length === 0) throw new Error("verification_evidence is required")
          const verificationOwner = state.mode === "assessment" ? "workflow-consultant" : "workflow-implementer"
          if (state.verificationPlan.status !== "planned" || !state.verificationPlan.tier || state.verificationPlan.owner !== verificationOwner) throw new Error(`verification requires a planned ${verificationOwner} verification plan`)
          const fingerprint = treeFingerprint(worktree, state.verificationPlan.artifactPaths)
          state = event(state, "verification_passed", summary || `${evidence.length} verification evidence item(s) recorded`, context.agent, context.sessionID)
          state.verification = { status: "passed", treeFingerprint: fingerprint, evidence, recordedAt: state.updatedAt }
          state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          state.nextAction = nextAction || (state.mode === "assessment"
            ? "Record capability evidence and present the assessment recommendation"
            : "Launch independent review against the verified tree")
        } else if (operation === "review_record") {
          if (state.mode === "assessment") throw new Error("assessment does not require an independent review; present the consultant recommendation instead")
          if (state.phase !== "verification" && state.phase !== "review") throw new Error("review can only be recorded in verification or the post-CI review phase")
          if (state.verification.status !== "passed" || state.verification.treeFingerprint !== treeFingerprint(worktree, state.verificationPlan.artifactPaths)) throw new Error("review requires current verification evidence")
          if (!args.review_outcome) throw new Error("review_outcome is required")
          const findings = (args.findings ?? []) as Finding[]
          if (args.review_outcome === "passed" && findings.length > 0) throw new Error("a passed review cannot contain findings")
          if (args.review_outcome === "blocked" && findings.length === 0) throw new Error("a blocked review must contain at least one finding")
          const fingerprint = treeFingerprint(worktree, state.verificationPlan.artifactPaths)
          state = event(state, args.review_outcome === "passed" ? "review_passed" : "review_blocked", summary || `Review ${args.review_outcome}`, context.agent, context.sessionID)
          state.review = { status: args.review_outcome, treeFingerprint: fingerprint, findings, summary: summary || "", recordedAt: state.updatedAt }
          state.nextAction = nextAction || (args.review_outcome === "passed" ? "Request ready after confirming capability evidence" : "Return all findings to workflow-implementer, then reverify and rereview")
        } else if (operation === "post_ci") {
          if (state.mode === "assessment") throw new Error("assessment does not enter the post-CI window")
          if (state.phase !== "verification") throw new Error("the post-CI window requires the verification phase")
          if (state.delivery.status !== "prepared") throw new Error("prepare the delivery branch/worktree before the post-CI window")
          if (state.verification.status !== "passed") throw new Error("verification must pass before the post-CI window")
          const fingerprint = treeFingerprint(worktree, state.verificationPlan.artifactPaths)
          state = event(state, "post_ci", summary || "Entered the post-CI review window", context.agent, context.sessionID)
          state.status = "post-ci"
          state.phase = "review"
          state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          state.ci = { status: "pending", treeFingerprint: fingerprint }
          state.manualReview = { status: "pending" }
          state.nextAction = nextAction || "Record the CI result, then run the independent reviewer on the committed tree"
        } else if (operation === "ci_status") {
          if (state.status !== "post-ci") throw new Error("the CI result can only be recorded in the post-CI window")
          if (!args.ci_outcome) throw new Error("ci_outcome is required (passed | failed)")
          const fingerprint = treeFingerprint(worktree, state.verificationPlan.artifactPaths)
          state = event(state, args.ci_outcome === "passed" ? "ci_passed" : "ci_failed", summary || `CI ${args.ci_outcome}`, context.agent, context.sessionID)
          state.ci = { status: args.ci_outcome, treeFingerprint: fingerprint }
          state.nextAction = nextAction || (args.ci_outcome === "passed" ? "Run the independent reviewer on the committed tree" : "Return CI failures to workflow-implementer, then rereview")
        } else if (operation === "manual_confirm") {
          const early = state.phase === "verification" || state.phase === "review"
          const inWindow = state.status === "post-ci"
          if (!early && !inWindow) throw new Error("user manual review confirmation applies right after verification or in the post-CI window")
          if (args.confirmation !== "explicit_user_manual_review") throw new Error("explicit user manual review confirmation is required")
          state = event(state, "manual_reviewed", summary || "User confirmed the result summary", context.agent, context.sessionID)
          state.manualReview = { status: "approved", confirmedAt: state.updatedAt, approvalSessionID: context.sessionID }
          state.nextAction = nextAction || "Reverify after any correction, run the independent review, then commit and record CI before ready"
        } else if (operation === "ready") {
          if (state.status !== "active" && state.status !== "post-ci") throw new Error(`workflow must be active or post-ci before ready (current: ${state.status})`)
          const errors = readyGateErrors(state, worktree)
          if (errors.length) throw new Error(`ready gate failed: ${errors.join("; ")}`)
          state = event(state, "ready_for_confirmation", summary || (state.mode === "assessment"
            ? "Assessment is ready; waiting for the user's decision"
            : "Implementation is ready; waiting for explicit user confirmation"), context.agent, context.sessionID)
          state.status = "ready"
          state.phase = "delivery"
          state.nextAction = nextAction || "Await explicit user confirmation before completing this change"
        } else if (operation === "reopen") {
          if (state.status !== "ready") throw new Error(`only a ready workflow can be reopened (current: ${state.status})`)
          state = event(state, "reopened", summary || "User requested another adjustment before completion", context.agent, context.sessionID)
          state.status = "active"
          state.phase = "planning"
          state.implementationBrief = { status: "missing", contractHash: "", summary: "" }
          state.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [], manualChecks: [], artifactPaths: [] }
          state.verification = { status: "missing", treeFingerprint: "", evidence: [] }
          state.review = { status: "missing", treeFingerprint: "", findings: [], summary: "" }
          state.ci = { status: "pending", treeFingerprint: "" }
          state.manualReview = { status: "pending" }
          state.nextAction = nextAction || "Reconcile the adjustment with the contract; redraft it if behavior changes, then present a new brief"
        } else if (operation === "complete") {
          if (state.status !== "ready") throw new Error(`workflow must be ready before completion (current: ${state.status})`)
          if (args.confirmation !== "explicit_user_confirmation") throw new Error("explicit user confirmation is required before completion")
          state = event(state, "completed", summary || "Completed", context.agent, context.sessionID)
          state.status = "completed"
          state.phase = "delivery"
          state.nextAction = nextAction || "No further action"
        } else if (operation === "abort") {
          state = event(state, "aborted", summary || "Aborted", context.agent, context.sessionID)
          state.status = "aborted"
          state.nextAction = nextAction || "Investigate the abort reason before starting another change"
        }
      }

      await persistState(project, context.sessionID, state, current.id)
      const readback = await loadState(project, changeId)
      if (!readback || readback.state.version !== state.version || readback.state.status !== state.status) throw new Error("Engram readback disagrees with the committed workflow state")
      return result(state, `Applied ${operation} to ${changeId}`)
    })
  },
})
