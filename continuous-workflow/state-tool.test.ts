import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import WorkflowState from "../tools/workflow_state.ts"

const directories: string[] = []
const originalStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR

function repository(withContract = false): string {
  const cwd = mkdtempSync(`${tmpdir()}/continuous-workflow-state-tool-`)
  directories.push(cwd)
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  run(["init", "-b", "feature/state-tool-test"])
  run(["config", "user.email", "workflow@example.invalid"])
  run(["config", "user.name", "Workflow Test"])
  if (withContract) {
    mkdirSync(`${cwd}/workflow/contracts`, { recursive: true })
    writeFileSync(`${cwd}/workflow/contracts/existing-change.md`, "# Existing contract\n")
  }
  writeFileSync(`${cwd}/README.md`, "test\n")
  run(["add", "."])
  run(["commit", "-m", "initial"])
  return cwd
}

function context(cwd: string): any {
  // Unique session id so persistent Engram sessions from earlier runs never
  // collide with the project of a fresh temp repository.
  return { agent: "workflow-lead", sessionID: `state-tool-session-${Math.random().toString(36).slice(2)}`, directory: cwd, worktree: cwd }
}

function stateFrom(result: any): any {
  const jsonStart = result.output.indexOf("{")
  return JSON.parse(result.output.slice(jsonStart))
}

afterEach(() => {
  if (originalStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
  else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = originalStateRoot
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

describe("workflow_state durable recovery", () => {
  test("status recovers from the local durable file after a restart", async () => {
    const cwd = repository()
    const stateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(stateRoot)
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = stateRoot
    const started = await WorkflowState.execute({
      operation: "start",
      change_id: "durable-recovery",
      goal: "test durable recovery",
      workflow_mode: "assessment",
    } as any, context(cwd))
    expect(started.output).toContain("Started workflow durable-recovery")

    const prevUrl = process.env.ENGRAM_URL
    const prevBin = process.env.ENGRAM_BIN
    try {
      // Force Engram to appear unreachable so `status` exercises the durable
      // mirror fallback regardless of whether a real Engram is running locally.
      process.env.ENGRAM_URL = "http://127.0.0.1:1"
      process.env.ENGRAM_BIN = "/nonexistent-engram"
      const status = await WorkflowState.execute({ operation: "status", change_id: "durable-recovery" } as any, context(cwd))
      expect(status.output).toContain("local durable mirror")
      expect(status.output).toContain('"changeId": "durable-recovery"')
    } finally {
      if (prevUrl === undefined) delete process.env.ENGRAM_URL
      else process.env.ENGRAM_URL = prevUrl
      if (prevBin === undefined) delete process.env.ENGRAM_BIN
      else process.env.ENGRAM_BIN = prevBin
    }
  })

  test("start refuses to replace an existing contract when state is missing", async () => {
    const cwd = repository(true)
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(process.env.CONTINUOUS_WORKFLOW_STATE_DIR)
    await expect(WorkflowState.execute({
      operation: "start",
      change_id: "existing-change",
      goal: "must not replace",
      workflow_mode: "assessment",
    } as any, context(cwd))).rejects.toThrow("existing contract but no durable workflow state")
  })

  test("drafts may be revised and phases may be recorded in any useful order", async () => {
    const cwd = repository()
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(process.env.CONTINUOUS_WORKFLOW_STATE_DIR)
    const ctx = context(cwd)
    const started = await WorkflowState.execute({
      operation: "start",
      change_id: "open-direction",
      goal: "follow new user direction",
      workflow_mode: "assessment",
    } as any, ctx)
    mkdirSync(`${cwd}/workflow/contracts`, { recursive: true })
    writeFileSync(`${cwd}/workflow/contracts/open-direction.md`, "# Revised direction\n")

    const drafted = await WorkflowState.execute({
      operation: "contract_draft",
      change_id: "open-direction",
      expected_version: stateFrom(started).version,
      contract_path: "workflow/contracts/open-direction.md",
      contract_version: 1,
      summary: "Draft after the user corrected the Lead",
    } as any, ctx)
    expect(stateFrom(drafted).contract.status).toBe("draft")

    const recorded = await WorkflowState.execute({
      operation: "transition",
      change_id: "open-direction",
      expected_version: stateFrom(drafted).version,
      phase: "review",
      summary: "Record the useful next point without restarting the change",
    } as any, ctx)
    expect(stateFrom(recorded).phase).toBe("review")
  })

  test("mode changes record direction without resetting the current work", async () => {
    const cwd = repository()
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(process.env.CONTINUOUS_WORKFLOW_STATE_DIR)
    const ctx = context(cwd)
    const started = await WorkflowState.execute({
      operation: "start",
      change_id: "direction-change",
      goal: "follow a corrected direction",
      workflow_mode: "assessment",
    } as any, ctx)
    const switched = await WorkflowState.execute({
      operation: "mode_set",
      change_id: "direction-change",
      expected_version: stateFrom(started).version,
      workflow_mode: "implementation",
      summary: "The user directed implementation after the assessment",
    } as any, ctx)
    const current = stateFrom(switched)
    expect(current.mode).toBe("implementation")
    expect(current.goal).toBe("follow a corrected direction")
    expect(current.phase).toBe("discovery")
  })
})
