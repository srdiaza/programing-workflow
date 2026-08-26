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
    mode: "implementation",
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
    verificationPlan: { status: "planned", tier: "focused", owner: "workflow-implementer", reason: "isolated change", requiredChecks: ["focused tests"], artifactPaths: [] },
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

  test("assessment skips implementation and delegates only its read-only verification", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    const assessment = state(repo.cwd, repo.contractHash, "planning")
    assessment.mode = "assessment"
    assessment.implementationBrief = { status: "missing", contractHash: "", summary: "" }
    assessment.delivery = { status: "missing", branch: "", baseBranch: "main", worktree: repo.cwd }
    assessment.verificationPlan = {
      status: "planned",
      tier: "focused",
      owner: "workflow-consultant",
      reason: "read-only library impact assessment",
      requiredChecks: ["inspect package changes"],
      artifactPaths: [],
    }
    await cacheState(plugin, "lead", assessment)

    await expect(plugin["tool.execute.before"](
      { tool: "edit", sessionID: "lead", callID: "assessment-contract" },
      { args: { filePath: `${repo.cwd}/workflow/contracts/plugin-test.md` } },
    )).resolves.toBeUndefined()

    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "assessment-implementer" },
      { args: { subagent_type: "workflow-implementer", prompt: "implement" } },
    )).rejects.toThrow("assessment is read-only")

    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "assessment-verify-transition" },
      { args: { operation: "transition", phase: "verification" } },
    )).resolves.toBeUndefined()
    assessment.phase = "verification"
    await cacheState(plugin, "lead", assessment)

    const verification = { args: { subagent_type: "workflow-consultant", prompt: "assess the library" } }
    const verificationInput = { tool: "task", sessionID: "lead", callID: "assessment-verify" }
    await plugin["tool.execute.before"](
      verificationInput,
      verification,
    )
    expect(verification.args.prompt).toContain("Execute only the recorded verification plan")
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "assessment-evidence-before" },
      { args: { operation: "verification_record" } },
    )).rejects.toThrow("complete the recorded read-only")
    await plugin["tool.execute.after"](verificationInput, verification)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "assessment-evidence-after" },
      { args: { operation: "verification_record" } },
    )).resolves.toBeUndefined()
  })

  test("assessment receipt follows the plan, not unrelated later tree drift or plugin context", async () => {
    const repo = repository()
    const receiptStateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-assessment-receipt-`)
    const priorStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = receiptStateRoot
    try {
      const assessment = state(repo.cwd, repo.contractHash, "verification")
      assessment.mode = "assessment"
      assessment.implementationBrief = { status: "missing", contractHash: "", summary: "" }
      assessment.delivery = { status: "missing", branch: "", baseBranch: "main", worktree: repo.cwd }
      assessment.verificationPlan = {
        status: "planned",
        tier: "focused",
        owner: "workflow-consultant",
        reason: "read-only assessment",
        requiredChecks: ["inspect current behavior"],
        artifactPaths: [],
        plannedAt: new Date().toISOString(),
      }

      const plugin = await hooks(repo.cwd)
      await identify(plugin, "lead", "workflow-lead")
      await cacheState(plugin, "lead", assessment)
      const taskInput = { tool: "task", sessionID: "lead", callID: "assessment-durable" }
      const taskOutput = { args: { subagent_type: "workflow-consultant", prompt: "assess" }, output: "assessment complete" }
      await plugin["tool.execute.before"](taskInput, taskOutput)
      await plugin["tool.execute.after"](taskInput, taskOutput)

      // This is outside the consultant task. It must not invalidate the
      // already completed read-only assessment.
      writeFileSync(`${repo.cwd}/unrelated-after-assessment.txt`, "created later\n")

      const recreated = await ContinuousWorkflow({ directory: `${repo.cwd}/different-plugin-context` } as any)
      await identify(recreated, "lead", "workflow-lead")
      await cacheState(recreated, "lead", assessment)
      await expect(recreated["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "assessment-record" },
        { args: { operation: "verification_record" } },
      )).resolves.toBeUndefined()
      await expect(recreated["tool.execute.before"](
        { tool: "task", sessionID: "lead", callID: "assessment-review" },
        { args: { subagent_type: "workflow-reviewer", prompt: "review" } },
      )).rejects.toThrow("workflow-consultant completes an assessment")
    } finally {
      if (priorStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
      else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = priorStateRoot
      rmSync(receiptStateRoot, { recursive: true, force: true })
    }
  })

  test("read-only specialists may perform fact-finding before the contract only in discovery", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    const discovery = state(repo.cwd, repo.contractHash, "discovery")
    discovery.contract = { path: "workflow/contracts/plugin-test.md", version: 0, hash: "", status: "missing" }
    discovery.implementationBrief = { status: "missing", contractHash: "", summary: "" }
    await cacheState(plugin, "lead", discovery)

    const allowed = { args: { subagent_type: "workflow-backend", prompt: "inspect reconciliation facts" } }
    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "pre-contract-discovery" },
      allowed,
    )).resolves.toBeUndefined()
    expect(allowed.args.prompt).toContain("pre-contract discovery")

    discovery.phase = "planning"
    await cacheState(plugin, "lead", discovery)
    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "pre-contract-planning" },
      { args: { subagent_type: "workflow-backend", prompt: "inspect" } },
    )).rejects.toThrow("approve the functional contract")
  })

  test("external SDD, Gentle AI, and OpenSpec invocations are forbidden", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash))

    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "sdd-agent" },
      { args: { subagent_type: "sdd-verify", prompt: "verify" } },
    )).rejects.toThrow("INDEPENDENCE GATE")
    await expect(plugin["tool.execute.before"](
      { tool: "bash", sessionID: "lead", callID: "sdd-command" },
      { args: { command: "sdd-verify" } },
    )).rejects.toThrow("INDEPENDENCE GATE")
    await expect(plugin["tool.execute.before"](
      { tool: "engram_mem_save", sessionID: "lead", callID: "raw-memory" },
      { args: { title: "workflow state" } },
    )).rejects.toThrow("canonical workflow persistence")
  })

  test("complete suites have one execution owner while focused probes remain available", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash))
    await expect(plugin["tool.execute.before"](
      { tool: "bash", sessionID: "lead", callID: "lead-full-suite" },
      { args: { command: "npm run quality-gate" } },
    )).rejects.toThrow("VERIFICATION OWNERSHIP")

    await identify(plugin, "reviewer", "workflow-reviewer")
    await expect(plugin["tool.execute.before"](
      { tool: "bash", sessionID: "reviewer", callID: "reviewer-full-suite" },
      { args: { command: "python -m pytest" } },
    )).rejects.toThrow("VERIFICATION OWNERSHIP")
    await expect(plugin["tool.execute.before"](
      { tool: "bash", sessionID: "reviewer", callID: "reviewer-focused" },
      { args: { command: "python -m pytest backend/tests/test_entries.py" } },
    )).resolves.toBeUndefined()
  })

  test("artifact safety blocks file-moving commands without rejecting a verification task", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash))
    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "cleanup" },
      { args: { subagent_type: "workflow-implementer", prompt: "run final verification; do not move, delete, stash, restore, or isolate files" } },
    )).resolves.toBeUndefined()
    await identify(plugin, "implementer", "workflow-implementer")
    await expect(plugin["tool.execute.before"](
      { tool: "bash", sessionID: "implementer", callID: "move" },
      { args: { command: "mv backend/uploads/test.pdf /tmp/test.pdf" } },
    )).rejects.toThrow("ARTIFACT SAFETY")
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

  test("verification can delegate a read-only Implementer without reopening implementation", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    const verified = state(repo.cwd, repo.contractHash, "verification")
    await cacheState(plugin, "lead", verified)
    const output = { args: { subagent_type: "workflow-implementer", prompt: "run recorded checks" } }
    await expect(plugin["tool.execute.before"](
      { tool: "task", sessionID: "lead", callID: "verify-only" },
      output,
    )).resolves.toBeUndefined()
    expect(output.args.prompt).toContain("Execute only the recorded verification plan")
  })

  test("verification-only Implementer cannot mutate the candidate", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    await identify(plugin, "lead", "workflow-lead")
    await cacheState(plugin, "lead", state(repo.cwd, repo.contractHash, "verification"))
    const input = { tool: "task", sessionID: "lead", callID: "verify-read-only" }
    const output = { args: { subagent_type: "workflow-implementer", prompt: "run recorded checks" } }
    await plugin["tool.execute.before"](input, output)
    writeFileSync(`${repo.cwd}/app.txt`, "unexpected verification mutation\n")
    await expect(plugin["tool.execute.after"](input, output)).rejects.toThrow("READ-ONLY VIOLATION")
  })

  test("implementation receipt survives compaction", async () => {
    const repo = repository()
    const receiptStateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-implementation-receipt-`)
    const priorStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = receiptStateRoot
    try {
      const plugin = await hooks(repo.cwd)
      await identify(plugin, "lead", "workflow-lead")
      const implementation = state(repo.cwd, repo.contractHash)
      await cacheState(plugin, "lead", implementation)
      const taskInput = { tool: "task", sessionID: "lead", callID: "implement-durable" }
      const taskOutput = { args: { subagent_type: "workflow-implementer", prompt: "implement" }, output: "Implemented approved package" }
      await plugin["tool.execute.before"](taskInput, taskOutput)
      await plugin["tool.execute.after"](taskInput, taskOutput)
      await plugin["experimental.session.compacting"]({ sessionID: "lead" }, { context: [] })
      await cacheState(plugin, "lead", implementation)
      await expect(plugin["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "verify-durable" },
        { args: { operation: "transition", phase: "verification" } },
      )).resolves.toBeUndefined()
    } finally {
      if (priorStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
      else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = priorStateRoot
      rmSync(receiptStateRoot, { recursive: true, force: true })
    }
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
    const taskOutput = { args: { subagent_type: "workflow-reviewer", prompt: "review" }, output: "<task state=\"completed\">\n<task_result>\nCoverage: reviewed candidate tree\nWORKFLOW_REVIEW_OUTCOME: PASS\n</task_result>\n</task>" }
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "record-pass" },
      { args: { operation: "review_record", review_outcome: "passed" } },
    )).resolves.toBeUndefined()

    taskOutput.output = "Verdict: PASS — no concrete findings"
    taskInput.callID = "review-ambiguous-pass"
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "record-ambiguous-pass" },
      { args: { operation: "review_record", review_outcome: "passed" } },
    )).rejects.toThrow("final exact line WORKFLOW_REVIEW_OUTCOME: PASS")

    taskOutput.output = "Finding R1\nWORKFLOW_REVIEW_OUTCOME: BLOCKED"
    taskInput.callID = "review-blocked"
    await plugin["tool.execute.before"](taskInput, taskOutput)
    await plugin["tool.execute.after"](taskInput, taskOutput)
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "false-pass" },
      { args: { operation: "review_record", review_outcome: "passed" } },
    )).rejects.toThrow("final exact line WORKFLOW_REVIEW_OUTCOME: PASS")
  })

  test("review receipt survives compaction and accepts the required Spanish PASS verdict", async () => {
    const repo = repository()
    const receiptStateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-receipt-`)
    const priorStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = receiptStateRoot
    try {
      const plugin = await hooks(repo.cwd)
      await identify(plugin, "lead", "workflow-lead")
      const verified = state(repo.cwd, repo.contractHash, "verification")
      const { treeFingerprint } = await import("./runtime.ts")
      verified.verification = { status: "passed", treeFingerprint: treeFingerprint(repo.cwd), evidence: ["tests pass"] }
      await cacheState(plugin, "lead", verified)
      const reviewInput = { tool: "task", sessionID: "lead", callID: "review-durable" }
      const reviewOutput = { args: { subagent_type: "workflow-reviewer", prompt: "review" }, output: "Cobertura: árbol revisado\nWORKFLOW_REVIEW_OUTCOME: PASS" }
      await plugin["tool.execute.before"](reviewInput, reviewOutput)
      await plugin["tool.execute.after"](reviewInput, reviewOutput)
      await plugin["experimental.session.compacting"]({ sessionID: "lead" }, { context: [] })
      await cacheState(plugin, "lead", verified)
      await expect(plugin["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "record-durable" },
        { args: { operation: "review_record", review_outcome: "passed" } },
      )).resolves.toBeUndefined()
    } finally {
      if (priorStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
      else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = priorStateRoot
      rmSync(receiptStateRoot, { recursive: true, force: true })
    }
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
    await identify(plugin, "lead", "workflow-lead", "Sí, apruebo")
    await expect(plugin["tool.execute.before"](input, output)).resolves.toBeUndefined()

    await identify(plugin, "lead", "workflow-lead", "CONFIEMO")
    await expect(plugin["tool.execute.before"](input, output)).resolves.toBeUndefined()

    const reconciled = state(repo.cwd, repo.contractHash, "verification")
    reconciled.updatedAt = new Date().toISOString()
    await cacheState(plugin, "lead", reconciled)
    await identify(plugin, "lead", "workflow-lead", "Confirmo")
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "reconcile-confirmed" },
      { args: { operation: "contract_metadata_reconcile" } },
    )).resolves.toBeUndefined()
  })

  test("explicit user approval survives compaction only for the unchanged state", async () => {
    const repo = repository()
    const receiptStateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-confirmation-`)
    const priorStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = receiptStateRoot
    try {
      const plugin = await hooks(repo.cwd)
      await identify(plugin, "lead", "workflow-lead")
      const draft = state(repo.cwd, repo.contractHash, "planning")
      draft.contract.status = "draft"
      draft.updatedAt = new Date().toISOString()
      await cacheState(plugin, "lead", draft)
      await identify(plugin, "lead", "workflow-lead", "Apruebo este contrato")
      await plugin["experimental.session.compacting"]({ sessionID: "lead" }, { context: [] })
      await cacheState(plugin, "lead", draft)
      await expect(plugin["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "approve-durable" },
        { args: { operation: "contract_approve" } },
      )).resolves.toBeUndefined()

      draft.updatedAt = new Date(Date.now() + 1000).toISOString()
      await cacheState(plugin, "lead", draft)
      await expect(plugin["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "approve-stale" },
        { args: { operation: "contract_approve" } },
      )).rejects.toThrow("explicit user response")
    } finally {
      if (priorStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
      else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = priorStateRoot
      rmSync(receiptStateRoot, { recursive: true, force: true })
    }
  })

  test("explicit user approval survives plugin recreation with a different context path", async () => {
    const repo = repository()
    const receiptStateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-confirmation-identity-`)
    const priorStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = receiptStateRoot
    try {
      const plugin = await hooks(repo.cwd)
      await identify(plugin, "lead", "workflow-lead")
      const draft = state(repo.cwd, repo.contractHash, "planning")
      draft.contract.status = "draft"
      draft.updatedAt = new Date().toISOString()
      await cacheState(plugin, "lead", draft)
      await identify(plugin, "lead", "workflow-lead", "Confirmo")

      const recreated = await ContinuousWorkflow({ directory: `${repo.cwd}/different-plugin-context` } as any)
      await cacheState(recreated, "lead", draft)
      await expect(recreated["tool.execute.before"](
        { tool: "workflow_state", sessionID: "lead", callID: "approve-after-recreate" },
        { args: { operation: "contract_approve" } },
      )).resolves.toBeUndefined()
    } finally {
      if (priorStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
      else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = priorStateRoot
      rmSync(receiptStateRoot, { recursive: true, force: true })
    }
  })

  test("captures approval when OpenCode provides the agent on the user message", async () => {
    const repo = repository()
    const plugin = await hooks(repo.cwd)
    const draft = state(repo.cwd, repo.contractHash, "planning")
    draft.contract.status = "draft"
    draft.updatedAt = new Date().toISOString()
    await plugin["tool.execute.after"](
      { tool: "workflow_state", sessionID: "lead", agent: "workflow-lead", callID: "state" },
      { output: JSON.stringify(draft) },
    )

    await plugin["chat.message"](
      { sessionID: "lead" },
      { message: { agent: "workflow-lead" }, parts: [{ type: "text", text: "Sí, apruebo" }] },
    )
    await expect(plugin["tool.execute.before"](
      { tool: "workflow_state", sessionID: "lead", callID: "approve-message-agent" },
      { args: { operation: "contract_approve" } },
    )).resolves.toBeUndefined()
  })
})
