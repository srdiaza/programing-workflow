import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  currentBranch,
  isProtectedBranch,
  normalizeWorkflowState,
  readWorktreeState,
  treeFingerprint,
  type WorkflowState,
} from "../continuous-workflow/runtime.ts"

const LEAD = "workflow-lead"
const LEAD_PREFIX = "workflow-lead-"
const IMPLEMENTER = "workflow-implementer"
const IMPLEMENTER_PREFIX = "workflow-implementer-"
const REVIEWER = "workflow-reviewer"
const READ_ONLY_SUBAGENTS = new Set([
  "workflow-consultant",
  "workflow-reviewer",
  "workflow-discovery",
  "workflow-architecture",
  "workflow-frontend",
  "workflow-backend",
  "workflow-security",
  "workflow-reliability",
])
// Engram tools the Lead may call to seed context from prior work. Canonical
// workflow persistence remains exclusively in `workflow_state`.
const LEAD_ENGRAM_READONLY = new Set([
  "engram_mem_search",
  "engram_mem_context",
  "engram_mem_get_observation",
  "engram_mem_current_project",
])

// Durable, non-state knowledge the Lead may write so future discovery reads are
// useful: decisions, architecture, bugfixes, patterns, learnings, and config.
// Canonical workflow change state (schema, changeId, expected_version, phase,
// verification/review records, and raw tool-capture types) is never allowed.
const LEAD_MEM_KNOWLEDGE_TYPES = new Set([
  "DECISION",
  "ARCHITECTURE",
  "BUGFIX",
  "PATTERN",
  "DISCOVERY",
  "LEARNING",
  "CONFIG",
])

function leadMemWriteBlocked(args: any): boolean {
  const type = String(args?.type ?? "").toUpperCase()
  // `mem_update` is partial: callers may provide only an observation ID and
  // the field being corrected, so an existing knowledge type is not repeated.
  const isPartialUpdate = Number.isInteger(args?.id)
  if (!LEAD_MEM_KNOWLEDGE_TYPES.has(type) && !isPartialUpdate) return true
  const title = String(args?.title ?? "")
  const content = String(args?.content ?? "")
  const stateMarker = /"schema"\s*:\s*"continuous-workflow\/v2"|"changeId"\s*:|"expected_version"\s*:|"treeFingerprint"\s*:\s*"|"review"\s*:\s*\{|"verification"\s*:\s*\{/i
  if (stateMarker.test(content)) return true
  if (/^workflow\s+\S*\s+v\d/i.test(title)) return true
  return false
}

type TaskSnapshot = {
  subagent: string
  kind: "implementation" | "verification" | "review" | "consultation" | "discovery"
  worktree: string
  fingerprint: string
  artifactPaths: string[]
  contractHash: string
  contractPath: string
  planKey?: string
}

type TaskReceipt = {
  fingerprint: string
  output: string
  planKey?: string
}

type UserConfirmation = {
  text: string
  at: number
}

function baseAgent(agent: string): string {
  for (const base of [IMPLEMENTER, ...READ_ONLY_SUBAGENTS]) {
    if (agent === base || agent.startsWith(base + "-")) return base
  }
  return agent
}

function isLead(agent: string | undefined): boolean {
  return agent === LEAD || Boolean(agent?.startsWith(LEAD_PREFIX))
}

function isImplementer(agent: string | undefined): boolean {
  return agent === IMPLEMENTER || Boolean(agent?.startsWith(IMPLEMENTER_PREFIX))
}

function isReviewer(agent: string | undefined): boolean {
  return agent === REVIEWER || Boolean(agent?.startsWith(`${REVIEWER}-`))
}

function fullSuiteCommand(command: string): boolean {
  const normalized = command.trim()
  const pytest = normalized.match(/(?:^|[;&|]\s*)(?:(?:\S+\/)?python3?|uv\s+run\s+(?:(?:\S+\/)?python3?))\s+-m\s+pytest\b(.*)$/i)
  if (pytest) {
    const args = pytest[1] ?? ""
    const hasFocusedTarget = /(?:^|\s)(?:[^\s=]*(?:\/|\\))?(?:tests?|specs?|__tests__)(?:\/|\\)|(?:^|\s)[^\s]*\.(?:py|ts|tsx|js|jsx)\b/i.test(args)
    if (!hasFocusedTarget) return true
  }
  const directPytest = normalized.match(/(?:^|[;&|]\s*)(?:(?:\S+\/)?pytest)\b(.*)$/i)
  if (directPytest) {
    const args = directPytest[1] ?? ""
    const hasFocusedTarget = /(?:^|\s)(?:[^\s=]*(?:\/|\\))?(?:tests?|specs?|__tests__)(?:\/|\\)|(?:^|\s)[^\s]*\.(?:py|ts|tsx|js|jsx)\b/i.test(args)
    if (!hasFocusedTarget) return true
  }
  return /(?:^|[;&|]\s*)(?:npm|pnpm)\s+run\s+(?:quality-gate|test(?=\s*$)|test:unit(?=\s*$))\b/i.test(normalized)
    || /(?:^|[;&|]\s*)yarn\s+(?:run\s+)?(?:quality-gate|test|test:unit)\b/i.test(normalized)
    || /(?:^|\s)(?:backend\/scripts\/run_quality_gate\.(?:ps1|sh)|\.\/backend\/scripts\/run_quality_gate\.(?:ps1|sh))(?:\s|$)/i.test(normalized)
    || /(?:^|[;&|]\s*)(?:npx\s+)?(?:vitest|jest)\s+(?:run\s*)?$/i.test(normalized)
}

function reviewerOutcome(output: string): "passed" | "blocked" | undefined {
  const taskResult = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i)?.[1] ?? output
  const match = taskResult.match(/\bWORKFLOW_REVIEW_OUTCOME:\s*(PASS|BLOCKED)\b/i)
  if (!match) return undefined
  return match[1].toUpperCase() === "PASS" ? "passed" : "blocked"
}

function implementationEvidenceKind(output: string): "complete" | "correction" | "incomplete" | undefined {
  const taskResult = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i)?.[1] ?? output
  // Scan the whole captured output so a short or truncated subagent result does
  // not lose the marker. The implementer is instructed to lead with the marker.
  if (/\bWORKFLOW_IMPLEMENTATION_EVIDENCE:\s*COMPLETE\b/i.test(taskResult)) return "complete"
  if (/\bWORKFLOW_IMPLEMENTATION_EVIDENCE:\s*CORRECTION_FOCUSED\b/i.test(taskResult)) return "correction"
  if (/\bWORKFLOW_IMPLEMENTATION_EVIDENCE:\s*INCOMPLETE\b/i.test(taskResult)) return "incomplete"
  return undefined
}

function isCorrectionLoop(state: WorkflowState): boolean {
  const implementationStart = state.history.map((entry) => entry.event).lastIndexOf("mode:implementation")
  let passedVerification = false
  for (const entry of state.history.slice(implementationStart + 1)) {
    if (entry.event === "verification_passed" || entry.event === "review_blocked") passedVerification = true
    if (entry.event === "phase:verification") passedVerification = true
    if (passedVerification && entry.event === "phase:implementation") return true
  }
  return false
}

function implementationEvidenceSufficient(output: string, state: WorkflowState): boolean {
  const kind = implementationEvidenceKind(output)
  return kind === "complete" || (kind === "correction" && isCorrectionLoop(state))
}

function userText(output: any): string {
  const content = Array.isArray(output?.parts)
    ? output.parts.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n").trim()
    : ""
  if (content) return content
  return output?.message?.summary ? `${output.message.summary.title ?? ""}\n${output.message.summary.body ?? ""}`.trim() : ""
}

function parseState(output: string): WorkflowState | null {
  const starts = [...output.matchAll(/(?:^|\n)\{/g)].map((match) => (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0)).reverse()
  for (const start of starts) {
    try {
      const state = normalizeWorkflowState(JSON.parse(output.slice(start)))
      if (state) return state
    } catch {}
  }
  return null
}

function targetPaths(args: any): string[] {
  const paths = new Set<string>()
  for (const key of ["filePath", "filepath", "file_path", "path"]) {
    if (typeof args?.[key] === "string") paths.add(args[key])
  }
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)) paths.add(match[1].trim())
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item)
      return
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) inspect(item)
    }
  }
  inspect(args)
  return [...paths]
}

function projectRelative(path: string, worktree: string): string {
  const normalized = path.replace(/\\/g, "/")
  const root = worktree.replace(/\/$/, "") + "/"
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized.replace(/^\.\//, "")
}

function sha256File(path: string): string {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex") } catch { return "" }
}

function contractHash(state: WorkflowState, worktree: string): string {
  return sha256File(`${worktree}/${state.contract.path}`)
}

function workflowFingerprint(state: WorkflowState, worktree: string): string {
  return treeFingerprint(worktree, state.verificationPlan.artifactPaths)
}

function receiptStateRoot(): string {
  return process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/share`}/opencode/continuous-workflow`
}

function verificationPlanKey(state: WorkflowState): string {
  return JSON.stringify({
    project: state.project,
    changeId: state.changeId,
    contractHash: state.contract.hash,
    plannedAt: state.verificationPlan.plannedAt || state.updatedAt,
    tier: state.verificationPlan.tier || "",
    owner: state.verificationPlan.owner,
    reason: state.verificationPlan.reason,
    requiredChecks: state.verificationPlan.requiredChecks,
    artifactPaths: state.verificationPlan.artifactPaths,
  })
}

function reviewReceiptPath(state: WorkflowState, worktree: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ project: state.project, changeId: state.changeId, contractHash: state.contract.hash, fingerprint: state.verification.treeFingerprint }))
    .digest("hex")
  return `${receiptStateRoot()}/review-receipts/${key}.json`
}

function legacyReviewReceiptPath(state: WorkflowState, worktree: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ worktree, changeId: state.changeId, contractHash: state.contract.hash, fingerprint: state.verification.treeFingerprint }))
    .digest("hex")
  return `${receiptStateRoot()}/review-receipts/${key}.json`
}

function persistReviewReceipt(state: WorkflowState, worktree: string, receipt: TaskReceipt): void {
  try {
    const path = reviewReceiptPath(state, worktree)
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, JSON.stringify(receipt), "utf8")
  } catch {}
}

function persistedReviewReceipt(state: WorkflowState, worktree: string): TaskReceipt | undefined {
  for (const path of [reviewReceiptPath(state, worktree), legacyReviewReceiptPath(state, worktree)]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (typeof parsed?.fingerprint === "string" && typeof parsed?.output === "string") return parsed as TaskReceipt
    } catch {}
  }
  return undefined
}

function implementationReceiptPath(state: WorkflowState, worktree: string, fingerprint: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ project: state.project, changeId: state.changeId, contractHash: state.contract.hash, fingerprint }))
    .digest("hex")
  return `${receiptStateRoot()}/implementation-receipts/${key}.json`
}

function legacyImplementationReceiptPath(state: WorkflowState, worktree: string, fingerprint: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ worktree, changeId: state.changeId, contractHash: state.contract.hash, fingerprint }))
    .digest("hex")
  return `${receiptStateRoot()}/implementation-receipts/${key}.json`
}

function persistImplementationReceipt(state: WorkflowState, worktree: string, receipt: TaskReceipt): void {
  try {
    const path = implementationReceiptPath(state, worktree, receipt.fingerprint)
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, JSON.stringify(receipt), "utf8")
  } catch {}
}

function persistedImplementationReceipt(state: WorkflowState, worktree: string, fingerprint: string): TaskReceipt | undefined {
  for (const path of [implementationReceiptPath(state, worktree, fingerprint), legacyImplementationReceiptPath(state, worktree, fingerprint)]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed?.fingerprint === fingerprint && typeof parsed?.output === "string") return parsed as TaskReceipt
    } catch {}
  }
  return undefined
}

function verificationReceiptPath(state: WorkflowState, worktree: string, fingerprint: string): string {
  const key = createHash("sha256")
    .update(verificationPlanKey(state))
    .digest("hex")
  return `${receiptStateRoot()}/verification-receipts/${key}.json`
}

function legacyVerificationReceiptPath(state: WorkflowState, worktree: string, fingerprint: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ worktree, changeId: state.changeId, contractHash: state.contract.hash, fingerprint }))
    .digest("hex")
  return `${receiptStateRoot()}/verification-receipts/${key}.json`
}

function persistVerificationReceipt(state: WorkflowState, worktree: string, receipt: TaskReceipt): void {
  try {
    const path = verificationReceiptPath(state, worktree, receipt.fingerprint)
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, JSON.stringify(receipt), "utf8")
  } catch {}
}

function persistedVerificationReceipt(state: WorkflowState, worktree: string, fingerprint: string): TaskReceipt | undefined {
  const planKey = verificationPlanKey(state)
  for (const path of [verificationReceiptPath(state, worktree, fingerprint), legacyVerificationReceiptPath(state, worktree, fingerprint)]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (typeof parsed?.fingerprint === "string" && typeof parsed?.output === "string" && parsed?.planKey === planKey) return parsed as TaskReceipt
    } catch {}
  }
  return undefined
}

function userConfirmationPath(state: WorkflowState): string {
  const stateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/share`}/opencode/continuous-workflow`
  const key = createHash("sha256").update(JSON.stringify({ project: state.project, changeId: state.changeId })).digest("hex")
  return `${stateRoot}/user-confirmations/${key}.json`
}

function legacyUserConfirmationPath(state: WorkflowState, worktree: string): string {
  const stateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/share`}/opencode/continuous-workflow`
  const key = createHash("sha256").update(JSON.stringify({ worktree, changeId: state.changeId })).digest("hex")
  return `${stateRoot}/user-confirmations/${key}.json`
}

function persistUserConfirmation(state: WorkflowState, confirmation: UserConfirmation): void {
  try {
    const path = userConfirmationPath(state)
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, JSON.stringify(confirmation), "utf8")
  } catch {}
}

function persistedUserConfirmation(state: WorkflowState, worktree: string): UserConfirmation | undefined {
  const candidates: UserConfirmation[] = []
  for (const path of [userConfirmationPath(state), legacyUserConfirmationPath(state, worktree)]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (typeof parsed?.text === "string" && typeof parsed?.at === "number") candidates.push(parsed as UserConfirmation)
    } catch {}
  }
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]
}

function stateRequired(state: WorkflowState | undefined): WorkflowState {
  if (!state) throw new Error("CONTINUOUS WORKFLOW STATE: no persisted state is available")
  return state
}

function approvalLooksExplicit(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("es")
  if (/^(?:sí|si)$/.test(normalized)) return true
  if (/^(?:sí|si)\s*[,;:.!?-]?\s*(?:apruebo|aprobado|confirmo|confiemo|confirmado|acepto|autorizo|ok|dale)\b/i.test(normalized)) return true
  return /^(apruebo|aprobado|confirmo|confiemo|confirmado|acepto|autorizo|ok|dale)(\b|[.!,:;])/i.test(normalized)
}

function readOnlyBash(command: string): boolean {
  const trimmed = command.trim()
  return /^(pwd|ls|head|tail|cat|rg|grep|find|git (status|diff|log|show|rev-parse|ls-files|grep|rev-list|describe|blame|remote|branch --show-current|branch --list|branch -a|branch -r|config --get)|codegraph (status|query|explore|node|files|callers|callees|impact|affected))(\s|$)/.test(trimmed)
}

function forbiddenLeadGit(command: string): boolean {
  return /(^|\s)git\s+(restore|reset|clean|stash|checkout\s+--|rebase|merge|cherry-pick|revert)(\s|$)/.test(command)
}

function forbiddenLeadFileMutation(command: string): boolean {
  return /(^|[|;&]\s*)(sed\s+-i|perl\s+-i|tee\b|touch\b|cp\b|mv\b|install\b|truncate\b)/.test(command)
    || /(^|\s)(--fix|--write)(\s|$)/.test(command)
    || /(^|\s)(>|>>)(\s|$)/.test(command)
}

function externalWorkflowInvocation(value: string): boolean {
  // Block only a genuine external-workflow orchestration (invoked as the first
  // executable word, or as an agent/subagent name). Text mentions, argument
  // values, file paths, and grep terms that merely contain the token are
  // allowed so real project content is not falsely blocked.
  const stripped = String(value).replace(/\\/g, "/")
  const isExternal = (tok: string) => /^(gentle-ai|openspec|sdd(?:[-_][a-z0-9]+)?)$/i.test(tok)
  const firstWord = stripped.trim().split(/[\s;&|]+/).find(Boolean) || ""
  if (isExternal(firstWord)) return true
  return /(^|[;&|]\s*)(gentle-ai|openspec|sdd(?:[-_][a-z0-9]+)?)(?=\s|$)/i.test(stripped)
}

function packagePrompt(state: WorkflowState, kind: "implementation" | "verification" | "review" | "consultation", fingerprint: string): string {
  const packageData = {
    schema: state.schema,
    change_id: state.changeId,
    contract: state.contract,
    implementation_brief: state.implementationBrief,
    delivery: state.delivery,
    capabilities: state.capabilities,
    verification_plan: state.verificationPlan,
    candidate_tree_fingerprint: fingerprint,
    authority: kind === "implementation"
      ? "Follow the Lead's current direction. Inspect, implement, test, and correct as needed. Use focused checks when useful and report commands, failures, remaining uncertainty, and any conflict in the current direction. This is evidence for the Lead, not a self-approval."
      : kind === "verification"
        ? "Run the checks that answer the Lead's current question. Prefer focused checks, but do not refuse a broader check when explicitly requested. Do not edit source, contracts, or Git state; do not delete, move, restore, or stash files. Report commands and evidence."
        : "Inspect the current request, implementation, and available evidence. Report concrete findings, uncertainty, and optional suggestions separately. This is advice for the Lead, not a lifecycle verdict.",
  }
  return `\n\n## Continuous Workflow working context\nThis context is advisory. Follow the current user direction and the Lead's task. If new evidence conflicts with it, report the conflict and continue the investigation or correction instead of stopping for a lifecycle reset.\n\`\`\`json\n${JSON.stringify(packageData, null, 2)}\n\`\`\`\n`
}

function discoveryPrompt(state: WorkflowState, fingerprint: string): string {
  const discovery = {
    change_id: state.changeId,
    user_goal: state.goal,
    acceptance_criteria: state.acceptanceCriteria,
    candidate_tree_fingerprint: fingerprint,
    authority: "Read-only investigation directed by workflow-lead. Establish facts about current behavior, visible terminology, data, constraints, and the user's latest direction. This may be a new investigation or a follow-up after the user corrected the Lead. Do not edit files or choose product scope; report evidence, conflicts, and recommendations for workflow-lead to synthesize.",
  }
  return `\n\n## Continuous Workflow investigation context\nThis context is advisory. The Lead may request another investigation whenever new information changes the working hypothesis.\n\`\`\`json\n${JSON.stringify(discovery, null, 2)}\n\`\`\`\n`
}

export const ContinuousWorkflow: Plugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory
  const agents = new Map<string, string>()
  const states = new Map<string, WorkflowState>()
  const lastUserMessages = new Map<string, UserConfirmation>()
  const taskSnapshots = new Map<string, TaskSnapshot>()
  const implementationReceipts = new Map<string, TaskReceipt>()
  const verificationReceipts = new Map<string, TaskReceipt>()
  const reviewReceipts = new Map<string, TaskReceipt>()

  function agentFor(input: any): string | undefined {
    return typeof input?.agent === "string" ? input.agent : agents.get(input.sessionID)
  }

  function activeWorktree(state?: WorkflowState): string {
    return state?.worktree || cwd
  }

  return {
    dispose: async () => {
      agents.clear()
      states.clear()
      lastUserMessages.clear()
      taskSnapshots.clear()
      implementationReceipts.clear()
      verificationReceipts.clear()
      reviewReceipts.clear()
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const sessionID = event.properties.info.id
      agents.delete(sessionID)
      states.delete(sessionID)
      lastUserMessages.delete(sessionID)
      implementationReceipts.delete(sessionID)
      verificationReceipts.delete(sessionID)
      reviewReceipts.delete(sessionID)
      for (const key of taskSnapshots.keys()) if (key.startsWith(sessionID + ":")) taskSnapshots.delete(key)
    },

    "chat.message": async (input, output) => {
      const messageAgent = typeof output?.message?.agent === "string" ? output.message.agent : undefined
      const agent = input.agent || messageAgent || agents.get(input.sessionID)
      if (agent) agents.set(input.sessionID, agent)
      if (isLead(agent)) {
        const confirmation = { text: userText(output), at: Date.now() }
        lastUserMessages.set(input.sessionID, confirmation)
        const current = states.get(input.sessionID)
        if (current && approvalLooksExplicit(confirmation.text)) persistUserConfirmation(current, confirmation)
      }
    },

    "tool.execute.before": async (input, output) => {
      const agent = agentFor(input)
      if (!isLead(agent) && !isImplementer(agent) && !isReviewer(agent)) return
      // Durable state is canonical and must win over stale snapshots from a
      // previous session, especially when a subagent runs in the same tree.
      const cachedStates = [...states.values()]
        .filter((candidate) => activeWorktree(candidate) === cwd)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      const state = readWorktreeState(cwd)
        ?? states.get(input.sessionID)
        ?? cachedStates[0]
        ?? undefined
      if (state) states.set(input.sessionID, state)

      if (isLead(agent) && /^engram_mem_/.test(input.tool)) {
        const isReadOnly = LEAD_ENGRAM_READONLY.has(input.tool)
        const isKnowledgeWrite = (input.tool === "engram_mem_save" || input.tool === "engram_mem_update") && !leadMemWriteBlocked(output?.args)
        if (!isReadOnly && !isKnowledgeWrite) {
          throw new Error("CONTINUOUS WORKFLOW INDEPENDENCE GATE: only read-only lookups (mem_search/mem_context/mem_get_observation) and durable knowledge writes (mem_save/mem_update of decisions, architecture, bugs, patterns, learnings) are allowed for the Lead; canonical workflow persistence is exclusively workflow_state")
        }
        return
      }

      if (input.tool === "workflow_state") {
        if (!isLead(agent)) throw new Error("CONTINUOUS WORKFLOW GATE: only workflow-lead may mutate or read canonical workflow_state")
        if (output.args?.operation === "contract_approve") {
          const current = stateRequired(state)
          const approval = lastUserMessages.get(input.sessionID) ?? persistedUserConfirmation(current, activeWorktree(current))
          if (!approval || approval.at < Date.parse(current.updatedAt) || !approvalLooksExplicit(approval.text)) {
            throw new Error("CONTINUOUS WORKFLOW GATE: contract reconciliation requires a new explicit user response after the current contract record was recorded")
          }
        }
        if (output.args?.operation === "complete") {
          const current = stateRequired(state)
          const approval = lastUserMessages.get(input.sessionID) ?? persistedUserConfirmation(current, activeWorktree(current))
          if (!approval || approval.at < Date.parse(current.updatedAt) || !approvalLooksExplicit(approval.text)) {
            throw new Error("CONTINUOUS WORKFLOW GATE: completion requires a new explicit user response after the workflow became ready")
          }
        }
        if (output.args?.operation === "manual_confirm") {
          const current = stateRequired(state)
          const approval = lastUserMessages.get(input.sessionID) ?? persistedUserConfirmation(current, activeWorktree(current))
          if (!approval || approval.at < Date.parse(current.updatedAt) || !approvalLooksExplicit(approval.text)) {
            throw new Error("CONTINUOUS WORKFLOW GATE: manual review confirmation requires a new explicit user response after the result summary was presented")
          }
        }
        return
      }

      if (input.tool === "task") {
        if (!isLead(agent)) throw new Error("CONTINUOUS WORKFLOW GATE: workflow-implementer cannot delegate")
        const current = state
        const requested = typeof output.args?.subagent_type === "string" ? output.args.subagent_type : ""
        if (externalWorkflowInvocation(requested)) {
          throw new Error("CONTINUOUS WORKFLOW INDEPENDENCE GATE: external workflow agents are not permitted")
        }
        const base = baseAgent(requested)
        const currentWorktree = activeWorktree(current)
        const fingerprint = current ? workflowFingerprint(current, currentWorktree) : treeFingerprint(currentWorktree)
        const key = `${input.sessionID}:${input.callID}`
        let taskKind: TaskSnapshot["kind"] = "consultation"

        if (base === IMPLEMENTER) {
          if (current?.mode === "assessment") {
            throw new Error("CONTINUOUS WORKFLOW ASSESSMENT GATE: an assessment is read-only; do not delegate workflow-implementer unless the user explicitly requests implementation and the Lead first enters implementation mode")
          }
          taskKind = "implementation"
          output.args.prompt = `${String(output.args.prompt ?? "")}${current ? packagePrompt(current, "implementation", fingerprint) : "\n\n## Open workflow\nWork on the Lead's current direction. Inspect, implement, test, and correct as needed; report blockers without requiring a lifecycle reset.\n"}`
        } else if (base === REVIEWER) {
          if (current?.mode === "assessment") throw new Error("CONTINUOUS WORKFLOW ASSESSMENT GATE: workflow-consultant completes an assessment; an independent Reviewer is only for implementation candidates")
          taskKind = "review"
          output.args.prompt = `${String(output.args.prompt ?? "")}${current ? packagePrompt(current, "review", fingerprint) : "\n\n## Open workflow review\nReview the current request, diff, and observable behavior. Report concrete findings and optional suggestions separately; do not wait for a lifecycle gate.\n"}`
        } else if (READ_ONLY_SUBAGENTS.has(base)) {
          const investigation = current && current.phase === "discovery" ? "discovery" : "consultation"
          taskKind = investigation
          output.args.prompt = `${String(output.args.prompt ?? "")}${current ? (investigation === "discovery" ? discoveryPrompt(current, fingerprint) : packagePrompt(current, "consultation", fingerprint)) : "\n\n## Open workflow investigation\nInvestigate the Lead's current question. This is read-only and may be a follow-up after the user corrected the direction. Return evidence and recommendations; do not wait for a contract gate.\n"}`
        }

        taskSnapshots.set(key, {
          subagent: base,
          kind: taskKind,
          worktree: currentWorktree,
          fingerprint,
          artifactPaths: current?.verificationPlan.artifactPaths ?? [],
          contractHash: current ? contractHash(current, currentWorktree) : "",
          contractPath: current?.contract.path ?? "",
          planKey: undefined,
        })
        return
      }

      if (["edit", "write", "apply_patch"].includes(input.tool)) {
        const paths = targetPaths(output.args)
        if (isLead(agent)) {
          const current = stateRequired(state)
          const currentWorktree = activeWorktree(current)
          const relative = paths.map((path) => projectRelative(path, currentWorktree))
          if (relative.length === 0 || relative.some((path) => path !== current.contract.path)) {
            throw new Error(`CONTINUOUS WORKFLOW AUTHORSHIP GATE: workflow-lead may edit only ${current.contract.path}; delegate application code and tests to workflow-implementer`)
          }
        } else if (isImplementer(agent)) {
          const current = state
          if (current?.mode === "assessment") throw new Error("CONTINUOUS WORKFLOW ASSESSMENT GATE: workflow-implementer is not allowed to mutate an assessment")
          const currentWorktree = activeWorktree(current)
          const relative = paths.map((path) => projectRelative(path, currentWorktree))
          if (relative.some((path) => path.startsWith("workflow/contracts/"))) throw new Error("CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementer cannot modify functional contracts")
          const branch = currentBranch(currentWorktree)
          if (!branch || isProtectedBranch(branch)) throw new Error(`CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementation on protected or unresolved branch is forbidden (${branch || "unresolved"})`)
        } else if (isReviewer(agent)) {
          throw new Error("CONTINUOUS WORKFLOW REVIEWER GATE: workflow-reviewer is read-only and cannot edit project files")
        }
        return
      }

      if (input.tool === "bash") {
        const command = String(output.args?.command ?? output.args?.cmd ?? "")
        if ((isLead(agent) || isImplementer(agent)) && externalWorkflowInvocation(command)) {
          throw new Error("CONTINUOUS WORKFLOW INDEPENDENCE GATE: external workflow commands are not permitted")
        }
        if (isLead(agent)) {
          if (forbiddenLeadGit(command)) throw new Error("CONTINUOUS WORKFLOW SAFETY GATE: destructive or history-rewriting Git operation is forbidden for workflow-lead")
          if (forbiddenLeadFileMutation(command)) throw new Error("CONTINUOUS WORKFLOW AUTHORSHIP GATE: workflow-lead cannot mutate project files through Bash; use the contract edit gate or workflow-implementer")
        } else if (isImplementer(agent)) {
          if (/(^|\s)git\s+(push|add|commit|restore|reset|clean|stash|checkout|switch|merge|rebase|cherry-pick|revert|branch\s+-[dDmMcC])(\s|$)/.test(command)) {
            throw new Error("CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementer cannot mutate Git state, history, branches, or remotes")
          }
          if (/(^|[;&|]\s*)(?:rm|mv)\s/.test(command)) {
            throw new Error("CONTINUOUS WORKFLOW ARTIFACT SAFETY: implementer cannot delete or move project files to satisfy verification or review")
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const agent = agentFor(input)
      if (input.tool === "workflow_state" && isLead(agent)) {
        const parsed = parseState(String(output.output ?? ""))
        if (parsed) states.set(input.sessionID, parsed)
        else {
          const durable = readWorktreeState(cwd)
          if (durable) states.set(input.sessionID, durable)
          else if (input.args?.operation === "status") states.delete(input.sessionID)
        }
        return
      }

      if (input.tool !== "task" || !isLead(agent)) return
      const key = `${input.sessionID}:${input.callID}`
      const snapshot = taskSnapshots.get(key)
      taskSnapshots.delete(key)
      if (!snapshot) return

      const after = treeFingerprint(snapshot.worktree, snapshot.artifactPaths)
      const changed = after !== snapshot.fingerprint
      const current = states.get(input.sessionID)
      const currentWorktree = activeWorktree(current)
      const currentContractHash = current ? contractHash(current, currentWorktree) : ""
      if (snapshot.contractHash && currentContractHash !== snapshot.contractHash) {
        throw new Error(`CONTINUOUS WORKFLOW CONTRACT INTEGRITY: ${snapshot.subagent} modified the approved contract ${snapshot.contractPath}`)
      }
      if ((READ_ONLY_SUBAGENTS.has(snapshot.subagent) || snapshot.kind === "verification") && changed) {
        throw new Error(`CONTINUOUS WORKFLOW READ-ONLY VIOLATION: ${snapshot.subagent} changed the project tree; workflow-lead must inspect and resolve the unexpected mutation`)
      }
      if (snapshot.subagent === IMPLEMENTER && snapshot.kind === "implementation") {
        const receipt = { fingerprint: after, output: String(output.output ?? "") }
        implementationReceipts.set(input.sessionID, receipt)
        if (current) persistImplementationReceipt(current, currentWorktree, receipt)
        reviewReceipts.delete(input.sessionID)
        output.output = `${output.output}\n\n[Continuous Workflow] Candidate tree fingerprint after implementation: ${after}. The Lead must inspect the actual diff before transitioning to verification.`
      }
      if (snapshot.kind === "verification" && current) {
        const receipt = { fingerprint: after, output: String(output.output ?? ""), planKey: snapshot.planKey }
        verificationReceipts.set(input.sessionID, receipt)
        persistVerificationReceipt(current, snapshot.worktree, receipt)
      }
      if (snapshot.subagent === REVIEWER) {
        const receipt = { fingerprint: after, output: String(output.output ?? "") }
        reviewReceipts.set(input.sessionID, receipt)
        if (current) persistReviewReceipt(current, currentWorktree, receipt)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const agent = agents.get(input.sessionID)
      if (!isLead(agent)) return
      states.delete(input.sessionID)
      implementationReceipts.delete(input.sessionID)
      verificationReceipts.delete(input.sessionID)
      reviewReceipts.delete(input.sessionID)
      output.context.push(
        "CONTINUOUS WORKFLOW V2 RECOVERY: canonical state cache was cleared by compaction. Call workflow_state operation=status before any delegation or mutation. Do not edit application code directly; only workflow-implementer owns implementation.",
      )
    },
  }
}

export default ContinuousWorkflow
