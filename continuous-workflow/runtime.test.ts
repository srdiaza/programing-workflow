import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import {
  WORKFLOW_SCHEMA,
  implementationGateErrors,
  normalizeWorkflowState,
  readyGateErrors,
  treeFingerprint,
  type WorkflowState,
} from "./runtime.ts"

const repositories: string[] = []

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
}

function repository(branch = "feature/workflow-test"): string {
  const cwd = mkdtempSync(`${tmpdir()}/continuous-workflow-`)
  repositories.push(cwd)
  git(cwd, "init", "-b", branch)
  git(cwd, "config", "user.email", "workflow@example.invalid")
  git(cwd, "config", "user.name", "Workflow Test")
  writeFileSync(`${cwd}/tracked.txt`, "initial\n")
  git(cwd, "add", "tracked.txt")
  git(cwd, "commit", "-m", "initial")
  return cwd
}

function state(cwd: string): WorkflowState {
  const timestamp = new Date().toISOString()
  return {
    schema: WORKFLOW_SCHEMA,
    changeId: "test-change",
    project: "test",
    worktree: cwd,
    goal: "test the workflow",
    acceptanceCriteria: ["observable behavior works"],
    phase: "verification",
    status: "active",
    version: 7,
    owner: { agent: "workflow-lead", sessionID: "session", claimedAt: timestamp, lastSeenAt: timestamp, leaseUntil: timestamp },
    nextAction: "review",
    updatedAt: timestamp,
    history: [],
    consultations: [],
    contract: { path: "workflow/contracts/test-change.md", version: 1, hash: "approved-hash", status: "approved" },
    implementationBrief: { status: "presented", contractHash: "approved-hash", summary: "brief" },
    delivery: { status: "prepared", strategy: "single-branch", branch: "feature/workflow-test", baseBranch: "main", worktree: cwd },
    capabilities: [
      { id: "C1", behavior: "current behavior", kind: "current", status: "verified", evidence: "test" },
      { id: "F1", behavior: "future path", kind: "future", status: "preserved", evidence: "design inspection" },
      { id: "N1", behavior: "excluded behavior", kind: "non-goal", status: "excluded", evidence: "diff inspection" },
    ],
    verificationPlan: { status: "planned", tier: "focused", owner: "workflow-implementer", reason: "isolated change", requiredChecks: ["focused tests"] },
    verification: { status: "missing", treeFingerprint: "", evidence: [] },
    review: { status: "missing", treeFingerprint: "", findings: [], summary: "" },
  }
}

afterAll(() => {
  for (const cwd of repositories) rmSync(cwd, { recursive: true, force: true })
})

describe("Continuous Workflow v2 gates", () => {
  test("legacy v1 state migrates in memory with mandatory gates missing", () => {
    const migrated = normalizeWorkflowState({
      ...state("/tmp/legacy"),
      schema: "continuous-workflow/v1",
      contract: undefined,
      implementationBrief: undefined,
      delivery: undefined,
      capabilities: undefined,
      verification: undefined,
      review: undefined,
    })
    expect(migrated?.schema).toBe(WORKFLOW_SCHEMA)
    expect(migrated?.contract.status).toBe("missing")
    expect(migrated?.capabilities).toEqual([])
  })

  test("implementation is permitted only on the prepared non-protected branch", () => {
    const cwd = repository()
    expect(implementationGateErrors(state(cwd), cwd)).toEqual([])
    git(cwd, "branch", "-m", "main")
    expect(implementationGateErrors(state(cwd), cwd)).toContain("implementation on protected branch main is forbidden")
  })

  test("implementation requires a complete verification plan owned by the Implementer", () => {
    const cwd = repository()
    const candidate = state(cwd)
    candidate.verificationPlan = { status: "missing", owner: "", reason: "", requiredChecks: [] }
    expect(implementationGateErrors(candidate, cwd)).toContain("verification plan is missing, incomplete, or has no workflow-implementer owner")
  })

  test("current-schema states without a verification plan fail closed while remaining readable", () => {
    const legacyCurrent = { ...state("/tmp/current"), verificationPlan: undefined }
    const normalized = normalizeWorkflowState(legacyCurrent)
    expect(normalized?.verificationPlan.status).toBe("missing")
  })

  test("ready evidence is invalidated by any candidate tree change", () => {
    const cwd = repository()
    const candidate = state(cwd)
    const fingerprint = treeFingerprint(cwd)
    candidate.verification = { status: "passed", treeFingerprint: fingerprint, evidence: ["tests pass"] }
    candidate.review = { status: "passed", treeFingerprint: fingerprint, findings: [], summary: "PASS" }
    expect(readyGateErrors(candidate, cwd)).toEqual([])
    writeFileSync(`${cwd}/tracked.txt`, "changed after review\n")
    expect(readyGateErrors(candidate, cwd)).toContain("verification is missing or stale for the current tree")
    expect(readyGateErrors(candidate, cwd)).toContain("independent review is missing or stale for the current tree")
  })

  test("a concrete finding always blocks ready", () => {
    const cwd = repository()
    const candidate = state(cwd)
    const fingerprint = treeFingerprint(cwd)
    candidate.verification = { status: "passed", treeFingerprint: fingerprint, evidence: ["tests pass"] }
    candidate.review = {
      status: "blocked",
      treeFingerprint: fingerprint,
      summary: "BLOCKED",
      findings: [{ id: "R1", severity: "P3", category: "quality", location: "tracked.txt:1", evidence: "unused code", impact: "noise", correction: "remove it" }],
    }
    const errors = readyGateErrors(candidate, cwd)
    expect(errors).toContain("independent review is missing or stale for the current tree")
    expect(errors).toContain("1 review finding(s) remain unresolved")
  })
})
