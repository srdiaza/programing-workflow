import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  currentBranch,
  implementationGateErrors,
  isProtectedBranch,
  normalizeWorkflowState,
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

type TaskSnapshot = {
  subagent: string
  fingerprint: string
  contractHash: string
  contractPath: string
}

type TaskReceipt = {
  fingerprint: string
  output: string
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

function stateRequired(state: WorkflowState | undefined): WorkflowState {
  if (!state) throw new Error("CONTINUOUS WORKFLOW GATE: run workflow_state operation=status or start before using mutating/delegating tools")
  return state
}

function approvalLooksExplicit(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("es")
  if (normalized === "sí" || normalized === "si") return true
  return /^(apruebo|aprobado|confirmo|confirmado|ok|dale)(\b|[.!,:;])/i.test(normalized)
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

function packagePrompt(state: WorkflowState, kind: "implementation" | "review" | "consultation", fingerprint: string): string {
  const packageData = {
    schema: state.schema,
    change_id: state.changeId,
    contract: state.contract,
    implementation_brief: state.implementationBrief,
    delivery: state.delivery,
    capabilities: state.capabilities,
    candidate_tree_fingerprint: fingerprint,
    authority: kind === "implementation"
      ? "Implement exactly this approved package. Do not reinterpret, narrow, or modify the contract."
      : "Inspect against this approved package. Report verified findings and optional suggestions separately.",
  }
  return `\n\n## Continuous Workflow enforced package\n\`\`\`json\n${JSON.stringify(packageData, null, 2)}\n\`\`\`\n`
}

export const ContinuousWorkflow: Plugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory
  const agents = new Map<string, string>()
  const states = new Map<string, WorkflowState>()
  const lastUserMessages = new Map<string, { text: string; at: number }>()
  const taskSnapshots = new Map<string, TaskSnapshot>()
  const implementationReceipts = new Map<string, TaskReceipt>()
  const reviewReceipts = new Map<string, TaskReceipt>()

  function agentFor(input: any): string | undefined {
    return typeof input?.agent === "string" ? input.agent : agents.get(input.sessionID)
  }

  return {
    dispose: async () => {
      agents.clear()
      states.clear()
      lastUserMessages.clear()
      taskSnapshots.clear()
      implementationReceipts.clear()
      reviewReceipts.clear()
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const sessionID = event.properties.info.id
      agents.delete(sessionID)
      states.delete(sessionID)
      lastUserMessages.delete(sessionID)
      implementationReceipts.delete(sessionID)
      reviewReceipts.delete(sessionID)
      for (const key of taskSnapshots.keys()) if (key.startsWith(sessionID + ":")) taskSnapshots.delete(key)
    },

    "chat.message": async (input, output) => {
      if (input.agent) agents.set(input.sessionID, input.agent)
      if (isLead(input.agent)) lastUserMessages.set(input.sessionID, { text: userText(output), at: Date.now() })
    },

    "tool.execute.before": async (input, output) => {
      const agent = agentFor(input)
      if (!isLead(agent) && !isImplementer(agent)) return
      const state = states.get(input.sessionID)

      if (input.tool === "workflow_state") {
        if (!isLead(agent)) throw new Error("CONTINUOUS WORKFLOW GATE: only workflow-lead may mutate or read canonical workflow_state")
        if (output.args?.operation === "contract_approve") {
          const current = stateRequired(state)
          const approval = lastUserMessages.get(input.sessionID)
          if (!approval || approval.at < Date.parse(current.updatedAt) || !approvalLooksExplicit(approval.text)) {
            throw new Error("CONTINUOUS WORKFLOW GATE: contract approval requires a new explicit user response after the current draft was recorded")
          }
        }
        if (output.args?.operation === "complete") {
          const current = stateRequired(state)
          const approval = lastUserMessages.get(input.sessionID)
          if (!approval || approval.at < Date.parse(current.updatedAt) || !approvalLooksExplicit(approval.text)) {
            throw new Error("CONTINUOUS WORKFLOW GATE: completion requires a new explicit user response after the workflow became ready")
          }
        }
        if (output.args?.operation === "transition" && output.args?.phase === "verification") {
          const current = stateRequired(state)
          const receipt = implementationReceipts.get(input.sessionID)
          const fingerprint = treeFingerprint(cwd)
          if (current.phase !== "implementation" || !receipt || receipt.fingerprint !== fingerprint) {
            throw new Error("CONTINUOUS WORKFLOW IMPLEMENTATION RECEIPT: transition to verification requires a completed workflow-implementer task for the current tree")
          }
        }
        if (output.args?.operation === "review_record") {
          const current = stateRequired(state)
          const receipt = reviewReceipts.get(input.sessionID)
          const fingerprint = treeFingerprint(cwd)
          if (!receipt || receipt.fingerprint !== fingerprint || current.verification.treeFingerprint !== fingerprint) {
            throw new Error("CONTINUOUS WORKFLOW REVIEW RECEIPT: review_record requires workflow-reviewer output for the currently verified tree")
          }
          const reportedPass = /(?:^|\n)\s*(?:Verdict:\s*)?PASS\s*(?:—|-|:)?\s*no concrete findings\b/i.test(receipt.output)
          const reportedBlocked = /(?:^|\n)\s*(?:Verdict:\s*)?BLOCKED\b/i.test(receipt.output)
          if (output.args?.review_outcome === "passed" && (!reportedPass || reportedBlocked)) {
            throw new Error("CONTINUOUS WORKFLOW REVIEW RECEIPT: a passing state cannot be recorded from reviewer output that is not an explicit zero-finding PASS")
          }
          if (output.args?.review_outcome === "blocked" && !reportedBlocked) {
            throw new Error("CONTINUOUS WORKFLOW REVIEW RECEIPT: blocked review state requires an explicit BLOCKED reviewer verdict")
          }
        }
        return
      }

      if (input.tool === "task") {
        if (!isLead(agent)) throw new Error("CONTINUOUS WORKFLOW GATE: workflow-implementer cannot delegate")
        const current = stateRequired(state)
        const requested = typeof output.args?.subagent_type === "string" ? output.args.subagent_type : ""
        const base = baseAgent(requested)
        const fingerprint = treeFingerprint(cwd)
        const key = `${input.sessionID}:${input.callID}`

        if (base === IMPLEMENTER) {
          const errors = implementationGateErrors(current, cwd)
          if (current.phase !== "implementation") errors.push(`workflow phase must be implementation (current: ${current.phase})`)
          if (errors.length) throw new Error(`CONTINUOUS WORKFLOW IMPLEMENTER GATE: ${errors.join("; ")}`)
          output.args.prompt = `${String(output.args.prompt ?? "")}${packagePrompt(current, "implementation", fingerprint)}`
        } else if (base === REVIEWER) {
          if (current.phase !== "verification") throw new Error("CONTINUOUS WORKFLOW REVIEW GATE: reviewer may run only after implementation in verification phase")
          if (current.verification.status !== "passed" || current.verification.treeFingerprint !== fingerprint) {
            throw new Error("CONTINUOUS WORKFLOW REVIEW GATE: current-tree verification must be recorded before reviewer delegation")
          }
          output.args.prompt = `${String(output.args.prompt ?? "")}${packagePrompt(current, "review", fingerprint)}`
        } else if (READ_ONLY_SUBAGENTS.has(base)) {
          if (current.contract.status !== "approved") throw new Error("CONTINUOUS WORKFLOW CONSULTATION GATE: approve the functional contract before specialist delegation")
          output.args.prompt = `${String(output.args.prompt ?? "")}${packagePrompt(current, "consultation", fingerprint)}`
        }

        taskSnapshots.set(key, { subagent: base, fingerprint, contractHash: contractHash(current, cwd), contractPath: current.contract.path })
        return
      }

      if (["edit", "write", "apply_patch"].includes(input.tool)) {
        const paths = targetPaths(output.args)
        if (isLead(agent)) {
          const current = stateRequired(state)
          const relative = paths.map((path) => projectRelative(path, cwd))
          if (relative.length === 0 || relative.some((path) => path !== current.contract.path)) {
            throw new Error(`CONTINUOUS WORKFLOW AUTHORSHIP GATE: workflow-lead may edit only ${current.contract.path}; delegate application code and tests to workflow-implementer`)
          }
          if (current.status !== "active") throw new Error(`CONTINUOUS WORKFLOW CONTRACT GATE: contract cannot be edited while workflow status is ${current.status}`)
          const branch = currentBranch(cwd)
          if (current.delivery.status !== "prepared" || current.delivery.worktree !== cwd || current.delivery.branch !== branch || isProtectedBranch(branch)) {
            throw new Error("CONTINUOUS WORKFLOW DELIVERY GATE: prepare and record a non-protected branch/worktree before editing the functional contract")
          }
        } else if (isImplementer(agent)) {
          const relative = paths.map((path) => projectRelative(path, cwd))
          if (relative.some((path) => path.startsWith("workflow/contracts/"))) throw new Error("CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementer cannot modify functional contracts")
          const branch = currentBranch(cwd)
          if (!branch || isProtectedBranch(branch)) throw new Error(`CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementation on protected or unresolved branch is forbidden (${branch || "unresolved"})`)
        }
        return
      }

      if (input.tool === "bash") {
        const command = String(output.args?.command ?? output.args?.cmd ?? "")
        if (isLead(agent)) {
          if (forbiddenLeadGit(command)) throw new Error("CONTINUOUS WORKFLOW SAFETY GATE: destructive or history-rewriting Git operation is forbidden for workflow-lead")
          if (forbiddenLeadFileMutation(command)) throw new Error("CONTINUOUS WORKFLOW AUTHORSHIP GATE: workflow-lead cannot mutate project files through Bash; use the contract edit gate or workflow-implementer")
          if (!state && !readOnlyBash(command) && !/^git\s+(switch\s+-c|checkout\s+-b)(\s|$)/.test(command)) {
            throw new Error("CONTINUOUS WORKFLOW BOOTSTRAP GATE: run workflow_state status/start before non-read-only Bash")
          }
        } else if (isImplementer(agent)) {
          if (/(^|\s)git\s+(push|add|commit|restore|reset|clean|stash|checkout|switch|merge|rebase|cherry-pick|revert|branch\s+-[dDmMcC])(\s|$)/.test(command)) {
            throw new Error("CONTINUOUS WORKFLOW IMPLEMENTER GATE: implementer cannot mutate Git state, history, branches, or remotes")
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const agent = agentFor(input)
      if (input.tool === "workflow_state" && isLead(agent)) {
        const state = parseState(String(output.output ?? ""))
        if (state) states.set(input.sessionID, state)
        else if (input.args?.operation === "status") states.delete(input.sessionID)
        return
      }

      if (input.tool !== "task" || !isLead(agent)) return
      const key = `${input.sessionID}:${input.callID}`
      const snapshot = taskSnapshots.get(key)
      taskSnapshots.delete(key)
      if (!snapshot) return

      const after = treeFingerprint(cwd)
      const changed = after !== snapshot.fingerprint
      const current = states.get(input.sessionID)
      const currentContractHash = current ? contractHash(current, cwd) : ""
      if (snapshot.contractHash && currentContractHash !== snapshot.contractHash) {
        throw new Error(`CONTINUOUS WORKFLOW CONTRACT INTEGRITY: ${snapshot.subagent} modified the approved contract ${snapshot.contractPath}`)
      }
      if (READ_ONLY_SUBAGENTS.has(snapshot.subagent) && changed) {
        throw new Error(`CONTINUOUS WORKFLOW READ-ONLY VIOLATION: ${snapshot.subagent} changed the project tree; workflow-lead must inspect and resolve the unexpected mutation`)
      }
      if (snapshot.subagent === IMPLEMENTER) {
        implementationReceipts.set(input.sessionID, { fingerprint: after, output: String(output.output ?? "") })
        reviewReceipts.delete(input.sessionID)
        output.output = `${output.output}\n\n[Continuous Workflow] Candidate tree fingerprint after implementation: ${after}. The Lead must inspect the actual diff before transitioning to verification.`
      }
      if (snapshot.subagent === REVIEWER) reviewReceipts.set(input.sessionID, { fingerprint: after, output: String(output.output ?? "") })
    },

    "experimental.session.compacting": async (input, output) => {
      const agent = agents.get(input.sessionID)
      if (!isLead(agent)) return
      states.delete(input.sessionID)
      implementationReceipts.delete(input.sessionID)
      reviewReceipts.delete(input.sessionID)
      output.context.push(
        "CONTINUOUS WORKFLOW V2 RECOVERY: canonical state cache was cleared by compaction. Call workflow_state operation=status before any delegation or mutation. Do not edit application code directly; only workflow-implementer owns implementation.",
      )
    },
  }
}

export default ContinuousWorkflow
