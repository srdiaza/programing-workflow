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
  return { agent: "workflow-lead", sessionID: "state-tool-session", directory: cwd, worktree: cwd }
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

    const status = await WorkflowState.execute({ operation: "status", change_id: "durable-recovery" } as any, context(cwd))
    expect(status.output).toContain("local durable file")
    expect(status.output).toContain('"changeId": "durable-recovery"')
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
})
