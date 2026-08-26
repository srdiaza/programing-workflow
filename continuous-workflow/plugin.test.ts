import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import ContinuousWorkflow from "../plugins/continuous_workflow"
import { WORKFLOW_SCHEMA, type WorkflowState } from "./runtime.ts"

const repositories: string[] = []

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
}

function repository(): { cwd: string; contractHash: string } {
  const cwd = mkdtempSync(`${tmpdir()}/continuous-workflow-plugin-`)
  repositories.push(cwd)
  git(cwd, "init", "-b", "feature/plugin-test")
  git(cwd, "config", "user.email", "workflow@example.invalid")
  git(cwd, "config", "user.name", "Workflow Test")
  mkdirSync(`${cwd}/workflow/contracts`, { recursive: true })
  writeFileSync(`${cwd}/workflow/contracts/plugin-test.md`, "# Contract\n")
  writeFileSync(`${cwd}/app.txt`, "initial\n")
  git(cwd, "add", ".")
  git(cwd, "commit", "-m", "initial")
  return { cwd, contractHash: createHash("sha256").update("# Contract\n").digest("hex") }
}

function state(cwd: string, contractHash: string, phase: WorkflowState["phase"] = "implementation"): WorkflowState {
  const timestamp = new Date(Date.now() - 1000).toISOString()
  return {
    schema: WORKFLOW_SCHEMA,
    changeId: "plugin-test",
    project: "plugin-test",
    worktree: cwd,
    goal: "prove gates",
    acceptanceCriteria: ["gates work"],
    phase,
    status: "active",
    version: 5,
    owner: { agent: "workflow-lead", sessionID: "lead", claimedAt: timestamp, lastSeenAt: timestamp, leaseUntil: timestamp },
    nextAction: "implement",
    updatedAt: timestamp,
    history: [],
    consultations: [],
    contract: { path: "workflow/contracts/plugin-test.md", version: 1, hash: contractHash, status: "approved" },
    implementationBrief: { status: "presented", contractHash, summary: "brief" },
    delivery: { status: "prepared", strategy: "single-branch", branch: "feature/plugin-test", baseBranch: "main", worktree: cwd },
    capabilities: [{ id: "C1", behavior: "gate behavior", kind: "current", status: "pending" }],
    verification: { status: "missing", treeFingerprint: "", evidence: [] },
    review: { status: "missing", treeFingerprint: "", findings: [], summary: "" },
  }
}

async function hooks(cwd: string): Promise<any> {
  return ContinuousWorkflow({ directory: cwd, worktree: cwd } as any)
}

async function identify(plugin: any, sessionID: string, agent: string, text = "start"): Promise<void> {
  await plugin["chat.message"]({ sessionID, agent }, { parts: [{ type: "text", text }] })
}

async function cacheState(plugin: any, sessionID: string, value: WorkflowState): Promise<void> {
  await plugin["tool.execute.after"](
    { tool: "workflow_state", sessionID, callID: "state", args: { operation: "status" } },
    { output: JSON.stringify(value) },
  )
}

afterAll(() => {
  for (const cwd of repositories) rmSync(cwd, { recursive: true, force: true })
})

describe("Continuous Workflow plugin enforcement", () => {
  test("Lead can edit only the exact contract path", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash))

    await expect(plugin["tool.execute.before"](
      { tool: "edit", sessionID: "lead", callID: "bad" },
      { args: { filePath: `${repo.cwd}/app.txt` } },
    )).rejects.toThrow("workflow-lead may edit only")

    await expect(plugin["tool.execute.before"](
      { tool: "edit", sessionID: "lead", callID: "contract" },
      { args: { filePath: `${repo.cwd}/workflow/contracts/plugin-test.md` } },
    )).resolves.toBeUndefined()

    await expect(plugin["tool.execute.before"](
      { tool: "apply_patch", sessionID: "lead", callID: "new-contract" },
      { args: { patch: "*** Begin Patch\n*** Add File: workflow/contracts/plugin-test.md\n+# Contract\n*** End Patch" } },
    )).resolves.toBeUndefined()

    await expect(plugin["tool.execute.before"](
      { tool: "apply_patch", sessionID: "lead", callID: "new-app-file" },
      { args: { patch: "*** Begin Patch\n*** Add File: app.txt\n+unexpected\n*** End Patch" } },
    )).rejects.toThrow("workflow-lead may edit only")
  })

  test("Implementer delegation requires the complete implementation gate", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    const blocked = state(repo.cwd, repo.contractHash, "planning")
    blocked.implementationBrief = { status: "missing", contractHash: "", summary: "" }
    await cacheState(plugin, "lead", blocked)
    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "blocked" },
      { args: { subagent_type: "workflow-implementer", prompt: "implement" } },
    )).rejects.toThrow("IMPLEMENTER GATE")

    const allowed = state(repo.cwd, repo.contractHash)
    await cacheState(plugin, "lead", allowed)
    const output = { args: { subagent_type: "workflow-implementer", prompt: "implement" } }
    await plugin["tool.execute.before"]({ tool: "task", sessionID: "lead", callID: "allowed" }, output)
    expect(output.args.prompt).toContain("Continuous Workflow enforced package")
    expect(output.args.prompt).toContain(repo.contractHash)
  })

  test("a read-only subagent mutation is detected after delegation", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash, "planning"))
    const input = { tool: "task", sessionID: "lead", callID: "review" }
    const output = { args: { subagent_type: "workflow-frontend", prompt: "inspect" }, output: "PASS" }
    await plugin["tool.execute.before"](input, output)
    writeFileSync(`${repo.cwd}/app.txt`, "unexpected mutation\n")
    await expect(plugin["tool.execute.after"](input, output)).rejects.toThrow("READ-ONLY VIOLATION")
  })

  test("verification transition requires an Implementer receipt for the current tree", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash))
    const transition = { tool: "workflow_state", sessionID: "lead", callID: "verify" }
    const transitionOutput = { args: { operation: "transition", phase: "verification" } }
    await expect(plugin["tool.execute.before"](transition, transitionOutput)).rejects.toThrow("IMPLEMENTATION RECEIPT")

    const taskInput = { tool: "task", sessionID: "lead", callID: "implement" }
    const taskOutput = { args: { subagent_type: "workflow-implementer", prompt: "implement" }, output: "Implemented approved package" }
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](transition, transitionOutput)).resolves.toBeUndefined()
  })

  test("passing review state requires an explicit zero-finding Reviewer receipt", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    const verified = state(repo.cwd, repo.contractHash, "verification")
    const { treeFingerprint } = await import("./runtime.ts")
    const fingerprint = treeFingerprint(repo.cwd)
    verified.verification = { status: "passed", treeFingerprint: fingerprint, evidence: ["tests pass"] }
    await cacheState(plugin, "lead", verified)

    const taskInput = { tool: "task", sessionID: "lead", callID: "review-pass" }
    const taskOutput = { args: { subagent_type: "workflow-reviewer", prompt: "review" }, output: "Verdict: PASS — no concrete findings" }
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "record-pass" },
      { args: { operation: "review_record", review_outcome: "passed" } },
    )).resolves.toBeUndefined()

    taskOutput.output = "Verdict: BLOCKED\nFinding R1"
    taskInput.callID = "review-blocked"
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "false-pass" },
      { args: { operation: "review_record", review_outcome: "passed" } },
    )).rejects.toThrow("zero-finding PASS")
  })

  test("contract approval requires a new explicit user response", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead", "please continue")
    const draft = state(repo.cwd, repo.contractHash, "planning")
    draft.contract.status = "draft"
    draft.updatedAt = new Date().toISOString()
    await cacheState(plugin, "lead", draft)
    const input = { tool: "workflow_state", sessionID: "lead", callID: "approve" }
    const output = { args: { operation: "contract_approve" } }
    await expect(plugin["tool.execute.before"](input, output)).rejects.toThrow("explicit user response")
    await identify(plugin, "lead", "workflow-lead", "Apruebo este contrato")
    await expect(plugin["tool.execute.before"](input, output)).resolves.toBeUndefined()
  })
})
