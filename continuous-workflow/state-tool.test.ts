import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import WorkflowState from "../tools/workflow_state.ts"

const directories: string[] = []
const originalFetch = globalThis.fetch
const originalStateRoot = process.env.CONTINUOUS_WORKFLOW_STATE_DIR
const originalEngramUrl = process.env.ENGRAM_URL
const originalEngramBin = process.env.ENGRAM_BIN

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
  globalThis.fetch = originalFetch
  if (originalStateRoot === undefined) delete process.env.CONTINUOUS_WORKFLOW_STATE_DIR
  else process.env.CONTINUOUS_WORKFLOW_STATE_DIR = originalStateRoot
  if (originalEngramUrl === undefined) delete process.env.ENGRAM_URL
  else process.env.ENGRAM_URL = originalEngramUrl
  if (originalEngramBin === undefined) delete process.env.ENGRAM_BIN
  else process.env.ENGRAM_BIN = originalEngramBin
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

describe("workflow_state durable recovery", () => {
  test("status recovers from the local mirror when Engram is unavailable", async () => {
    const cwd = repository()
    const stateRoot = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(stateRoot)
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = stateRoot
    process.env.ENGRAM_URL = "http://127.0.0.1:17437"
    process.env.ENGRAM_BIN = "/definitely/missing/engram"
    let healthy = true
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      if (url.endsWith("/health")) {
        if (!healthy) throw new Error("Engram unavailable")
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/sessions") && method === "POST") return new Response("{}", { status: 200 })
      if (url.includes("/observations?") && method === "GET") return new Response("[]", { status: 200 })
      if (url.endsWith("/observations") && method === "POST") return new Response(JSON.stringify({ id: 7001 }), { status: 200, headers: { "Content-Type": "application/json" } })
      throw new Error(`unexpected Engram request: ${method} ${url}`)
    }) as typeof fetch

    const started = await WorkflowState.execute({
      operation: "start",
      change_id: "durable-recovery",
      goal: "test durable recovery",
      workflow_mode: "assessment",
    } as any, context(cwd))
    expect(started.output).toContain("Started workflow durable-recovery")

    healthy = false
    const status = await WorkflowState.execute({ operation: "status", change_id: "durable-recovery" } as any, context(cwd))
    expect(status.output).toContain("local durable mirror")
    expect(status.output).toContain('"changeId": "durable-recovery"')
  })

  test("start refuses to replace an existing contract when state is missing", async () => {
    const cwd = repository(true)
    process.env.CONTINUOUS_WORKFLOW_STATE_DIR = mkdtempSync(`${tmpdir()}/continuous-workflow-state-root-`)
    directories.push(process.env.CONTINUOUS_WORKFLOW_STATE_DIR)
    process.env.ENGRAM_URL = "http://127.0.0.1:17437"
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      if (url.endsWith("/health")) return new Response("{}", { status: 200 })
      if (url.endsWith("/sessions") && method === "POST") return new Response("{}", { status: 200 })
      if (url.includes("/observations?") && method === "GET") return new Response("[]", { status: 200 })
      throw new Error(`unexpected Engram request: ${method} ${url}`)
    }) as typeof fetch

    await expect(WorkflowState.execute({
      operation: "start",
      change_id: "existing-change",
      goal: "must not replace",
      workflow_mode: "assessment",
    } as any, context(cwd))).rejects.toThrow("existing contract but no durable workflow state")
  })
})
