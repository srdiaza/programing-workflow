import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

export const WORKFLOW_SCHEMA = "continuous-workflow/v2" as const
export const LEGACY_WORKFLOW_SCHEMA = "continuous-workflow/v1" as const
export const PHASES = ["discovery", "planning", "implementation", "verification", "review", "delivery"] as const
export const STATUSES = ["active", "post-ci", "ready", "completed", "blocked", "aborted"] as const
export const WORKFLOW_MODES = ["implementation", "assessment"] as const
export const DELIVERY_STRATEGIES = ["single-branch", "feature-branch-chain", "stacked-prs", "single-pr-exception"] as const
export const VERIFICATION_TIERS = ["focused", "complete"] as const

export type Phase = (typeof PHASES)[number]
export type Status = (typeof STATUSES)[number]
export type WorkflowMode = (typeof WORKFLOW_MODES)[number]
export type DeliveryStrategy = (typeof DELIVERY_STRATEGIES)[number]
export type VerificationTier = (typeof VERIFICATION_TIERS)[number]

export type Owner = {
  agent: string
  sessionID: string
  claimedAt: string
  lastSeenAt: string
  leaseUntil: string
}

export type HistoryEntry = {
  version: number
  event: string
  summary: string
  actor: string
  sessionID: string
  at: string
}

export type Consultation = {
  kind: "consultation" | "review"
  actor: string
  sessionID: string
  summary: string
  at: string
}

export type Capability = {
  id: string
  behavior: string
  kind: "current" | "future" | "non-goal"
  status: "pending" | "verified" | "preserved" | "excluded"
  evidence?: string
}

export type Finding = {
  id: string
  severity: string
  category: string
  location: string
  evidence: string
  impact: string
  correction: string
}

export type WorkflowState = {
  schema: typeof WORKFLOW_SCHEMA
  changeId: string
  project: string
  worktree: string
  goal: string
  acceptanceCriteria: string[]
  mode: WorkflowMode
  phase: Phase
  status: Status
  profile?: string
  version: number
  owner: Owner
  nextAction: string
  updatedAt: string
  history: HistoryEntry[]
  consultations: Consultation[]
  contract: {
    path: string
    version: number
    hash: string
    status: "missing" | "draft" | "approved"
    approvedAt?: string
    approvalSessionID?: string
    approvalEvidence?: string
  }
  implementationBrief: {
    status: "missing" | "presented"
    contractHash: string
    summary: string
    presentedAt?: string
  }
  delivery: {
    status: "missing" | "prepared"
    strategy?: DeliveryStrategy
    branch: string
    baseBranch: string
    worktree: string
    preparedAt?: string
  }
  capabilities: Capability[]
  verificationPlan: {
    status: "missing" | "planned"
    tier?: VerificationTier
    owner: "workflow-implementer" | "workflow-consultant" | ""
    reason: string
    requiredChecks: string[]
    artifactPaths: string[]
    plannedAt?: string
  }
  verification: {
    status: "missing" | "passed"
    treeFingerprint: string
    evidence: string[]
    recordedAt?: string
  }
  review: {
    status: "missing" | "blocked" | "passed"
    treeFingerprint: string
    findings: Finding[]
    summary: string
    recordedAt?: string
  }
  ci: {
    status: "pending" | "passed" | "failed"
    treeFingerprint: string
    recordedAt?: string
  }
  manualReview: {
    status: "pending" | "approved"
    confirmedAt?: string
    approvalSessionID?: string
  }
}

type LegacyState = Omit<WorkflowState, "schema" | "contract" | "implementationBrief" | "delivery" | "capabilities" | "verificationPlan" | "verification" | "review"> & {
  schema: typeof LEGACY_WORKFLOW_SCHEMA
}

export function expectedContractPath(changeId: string): string {
  return `workflow/contracts/${changeId}.md`
}

export function normalizeWorkflowState(value: unknown): WorkflowState | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<WorkflowState> & { schema?: string; changeId?: string }
  if (!candidate.changeId) return null
  if (candidate.schema === WORKFLOW_SCHEMA) {
    const current = candidate as WorkflowState
    return {
      ...current,
      mode: current.mode === "assessment" ? "assessment" : "implementation",
      verificationPlan: { ...(current.verificationPlan ?? { status: "missing", owner: "", reason: "", requiredChecks: [] }), artifactPaths: current.verificationPlan?.artifactPaths ?? [] },
      ci: current.ci ?? { status: "pending", treeFingerprint: "" },
      manualReview: current.manualReview ?? { status: "pending" },
    }
  }
  if (candidate.schema !== LEGACY_WORKFLOW_SCHEMA) return null

  const legacy = candidate as LegacyState
  return {
    ...legacy,
    schema: WORKFLOW_SCHEMA,
    mode: "implementation",
    contract: {
      path: expectedContractPath(legacy.changeId),
      version: 0,
      hash: "",
      status: "missing",
    },
    implementationBrief: { status: "missing", contractHash: "", summary: "" },
    delivery: {
      status: "missing",
      branch: "",
      baseBranch: "",
      worktree: legacy.worktree ?? "",
    },
    capabilities: [],
    verificationPlan: { status: "missing", owner: "", reason: "", requiredChecks: [], artifactPaths: [] },
    verification: { status: "missing", treeFingerprint: "", evidence: [] },
    review: { status: "missing", treeFingerprint: "", findings: [], summary: "" },
    ci: { status: "pending", treeFingerprint: "" },
    manualReview: { status: "pending" },
  }
}

function git(worktree: string, args: string[]): { ok: boolean; stdout: Buffer } {
  const result = spawnSync("git", ["-C", worktree, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 })
  return { ok: result.status === 0, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "") }
}

export function currentBranch(worktree: string): string {
  const result = git(worktree, ["branch", "--show-current"])
  return result.ok ? result.stdout.toString().trim() : ""
}

export function isProtectedBranch(branch: string): boolean {
  return branch === "main" || branch === "master"
}

function stateDir(): string {
  if (process.env.CONTINUOUS_WORKFLOW_STATE_DIR) return join(process.env.CONTINUOUS_WORKFLOW_STATE_DIR, "states")
  return join(process.env.HOME ?? homedir(), ".local", "share", "opencode", "continuous-workflow", "states")
}

function worktreeProject(worktree: string): string {
  const remote = git(worktree, ["remote", "get-url", "origin"])
  if (remote.ok) {
    const name = remote.stdout.toString().trim().replace(/\.git$/, "").split(/[/:]/).pop()
    if (name) return name
  }
  const root = git(worktree, ["rev-parse", "--show-toplevel"])
  if (root.ok) {
    const name = root.stdout.toString().trim().split("/").pop()
    if (name) return name
  }
  return worktree.split("/").filter(Boolean).pop() ?? "unknown-project"
}

// Durable state recovery for the plugin gates. The state tool mirrors every
// mutation to `$STATE_DIR/states/<sha256(project\0changeId)>.json`, so a fresh
// healthy change is always recoverable from disk even when the plugin's
// in-memory cache is empty (e.g. after truncation of a status output or after a
// restart). Returns the newest matching state for a worktree or null.
export function readWorktreeState(worktree: string): WorkflowState | null {
  try {
    const project = worktreeProject(worktree)
    let best: WorkflowState | null = null
    for (const file of readdirSync(stateDir())) {
      if (!file.endsWith(".json")) continue
      try {
        const state = normalizeWorkflowState(JSON.parse(readFileSync(join(stateDir(), file), "utf8")))
        if (!state) continue
        if (state.worktree !== worktree && state.project !== project) continue
        if (!best || state.version > best.version || (state.version === best.version && Date.parse(state.updatedAt) > Date.parse(best.updatedAt))) {
          best = state
        }
      } catch { /* skip corrupt or non-state json */ }
    }
    return best
  } catch {
    return null
  }
}

export function treeFingerprint(worktree: string, artifactPaths: string[] = []): string {
  const hash = createHash("sha256")
  const commands = [
    ["rev-parse", "HEAD"],
    ["diff", "--binary", "--no-ext-diff"],
    ["diff", "--binary", "--no-ext-diff", "--cached"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]
  const outputs = commands.map((args) => git(worktree, args))
  for (const [index, output] of outputs.slice(0, 3).entries()) {
    hash.update(String(index))
    hash.update(output.ok ? output.stdout : Buffer.from("<git-error>"))
  }

  const allowed = artifactPaths.map((path) => path.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean)
  const untracked = (outputs[3].ok ? outputs[3].stdout.toString().split("\0").filter(Boolean) : [])
    .filter((relative) => !allowed.some((path) => relative === path || relative.startsWith(`${path}/`)))
    .sort()
  for (const relative of untracked) {
    hash.update(relative)
    try { hash.update(readFileSync(`${worktree}/${relative}`)) } catch { hash.update("<unreadable>") }
  }
  return hash.digest("hex")
}

export function implementationGateErrors(state: WorkflowState, worktree: string): string[] {
  const errors: string[] = []
  if (state.status !== "active") errors.push(`workflow status must be active (current: ${state.status})`)
  if (state.contract.status !== "approved" || !state.contract.hash) errors.push("approved functional contract is missing")
  if (state.implementationBrief.status !== "presented" || state.implementationBrief.contractHash !== state.contract.hash) {
    errors.push("implementation brief is missing or belongs to another contract version")
  }
  if (state.delivery.status !== "prepared") errors.push("delivery branch/worktree has not been prepared")
  if (state.verificationPlan.status !== "planned" || !state.verificationPlan.tier || state.verificationPlan.owner !== "workflow-implementer" || !state.verificationPlan.reason || state.verificationPlan.requiredChecks.length === 0) {
    errors.push("verification plan is missing, incomplete, or has no workflow-implementer owner")
  }
  const branch = currentBranch(worktree)
  if (!branch) errors.push("current Git branch could not be resolved")
  if (isProtectedBranch(branch)) errors.push(`implementation on protected branch ${branch} is forbidden`)
  if (state.delivery.branch && branch !== state.delivery.branch) errors.push(`current branch ${branch || "(detached)"} differs from prepared branch ${state.delivery.branch}`)
  if (state.delivery.worktree && state.delivery.worktree !== worktree) errors.push("current worktree differs from the prepared worktree")
  return errors
}

export function assessmentGateErrors(state: WorkflowState, worktree: string): string[] {
  const errors: string[] = []
  if (state.status !== "active") errors.push(`workflow status must be active (current: ${state.status})`)
  if (state.mode !== "assessment") errors.push(`workflow mode must be assessment (current: ${state.mode})`)
  if (state.contract.status !== "approved" || !state.contract.hash) errors.push("approved functional assessment contract is missing")
  if (state.verificationPlan.status !== "planned" || !state.verificationPlan.tier || state.verificationPlan.owner !== "workflow-consultant" || !state.verificationPlan.reason || state.verificationPlan.requiredChecks.length === 0) {
    errors.push("assessment verification plan is missing, incomplete, or has no workflow-consultant owner")
  }
  if (state.phase !== "verification" && state.phase !== "delivery") errors.push(`assessment must be in verification or delivery phase (current: ${state.phase})`)
  // An assessment records a completed read-only investigation, not a
  // candidate implementation. Its evidence remains valid when unrelated
  // files change after the consultant finished; implementation/review tracks
  // retain the strict current-tree check below.
  if (state.verification.status !== "passed" || !state.verification.treeFingerprint || state.verification.evidence.length === 0) errors.push("assessment verification evidence is missing")
  return errors
}

export function readyGateErrors(state: WorkflowState, worktree: string): string[] {
  const errors = state.mode === "assessment" ? assessmentGateErrors(state, worktree) : []
  if (state.mode === "assessment") {
    if (state.phase !== "verification" && state.phase !== "delivery") errors.push(`assessment must be in verification or delivery (current: ${state.phase})`)
  } else {
    if (state.phase !== "review" && state.phase !== "delivery") errors.push(`implementation must enter the post-CI review window (phase review) before ready (current: ${state.phase})`)
  }
  if (state.mode !== "assessment") {
    const impl = implementationGateErrors(state, worktree).filter((e) => !e.startsWith("workflow status must be active"))
    errors.push(...impl)
    const fingerprint = treeFingerprint(worktree, state.verificationPlan.artifactPaths)
    if (state.verification.status !== "passed" || state.verification.treeFingerprint !== fingerprint) errors.push("verification is missing or stale for the current tree")
    if (state.review.status !== "passed" || state.review.treeFingerprint !== fingerprint) errors.push("independent review is missing or stale for the current tree")
    if (state.review.findings.length > 0) errors.push(`${state.review.findings.length} review finding(s) remain unresolved`)
    if (state.manualReview.status !== "approved") errors.push("the change is not ready until the user confirms manual review of the result summary")
  }
  if (state.capabilities.length === 0) errors.push("capability matrix is empty")
  for (const capability of state.capabilities) {
    if (capability.kind === "current" && capability.status !== "verified") errors.push(`current capability ${capability.id} is not verified`)
    if (capability.kind === "future" && capability.status !== "preserved") errors.push(`future capability ${capability.id} is not confirmed as preserved`)
    if (capability.kind === "non-goal" && capability.status !== "excluded") errors.push(`non-goal ${capability.id} is not confirmed as excluded`)
  }
  return errors
}
