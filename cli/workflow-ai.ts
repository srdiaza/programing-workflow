#!/usr/bin/env bun

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

type AreaName = "discovery" | "architecture" | "frontend" | "backend" | "security" | "reliability"

type WorkflowConfig = {
  schema: "continuous-workflow/config/v1"
  lead_model: string
  areas: Record<AreaName, string>
  reviewer_model: string
  review_policy: "required" | "optional" | "disabled"
  consultation_policy: "always" | "on-demand"
  engram_url: string
}

const home = process.env.HOME || "/tmp"
const opencodeRoot = process.env.OPENCODE_CONFIG_ROOT || `${home}/.config/opencode`
const configPath = process.env.CONTINUOUS_WORKFLOW_CONFIG || `${opencodeRoot}/continuous-workflow/config.json`
const agentRoot = `${opencodeRoot}/agents`

const defaults: WorkflowConfig = {
  schema: "continuous-workflow/config/v1",
  lead_model: "openai/gpt-5.6-luna",
  areas: {
    discovery: "openai/gpt-5.6-luna",
    architecture: "minimax/MiniMax-M3",
    frontend: "opencode-go/kimi-k2.7-code",
    backend: "openai/gpt-5.6-luna",
    security: "opencode-go/kimi-k2.7-code",
    reliability: "minimax/MiniMax-M3",
  },
  reviewer_model: "minimax/MiniMax-M3",
  review_policy: "required",
  consultation_policy: "on-demand",
  engram_url: "http://127.0.0.1:7437",
}

const agentModels: Record<string, string> = {
  "workflow-lead": "lead_model",
  "workflow-discovery": "areas.discovery",
  "workflow-architecture": "areas.architecture",
  "workflow-frontend": "areas.frontend",
  "workflow-backend": "areas.backend",
  "workflow-security": "areas.security",
  "workflow-reliability": "areas.reliability",
  "workflow-reviewer": "reviewer_model",
  "workflow-consultant": "areas.discovery",
}

function mergeConfig(value: Partial<WorkflowConfig> | undefined): WorkflowConfig {
  return {
    ...defaults,
    ...(value ?? {}),
    areas: { ...defaults.areas, ...(value?.areas ?? {}) },
  }
}

async function loadConfig(): Promise<WorkflowConfig | null> {
  const file = Bun.file(configPath)
  if (!(await file.exists())) return null
  const parsed = JSON.parse(await file.text()) as Partial<WorkflowConfig>
  if (parsed.schema && parsed.schema !== defaults.schema) throw new Error(`Unsupported workflow config schema: ${parsed.schema}`)
  return mergeConfig(parsed)
}

async function saveConfig(config: WorkflowConfig): Promise<void> {
  const directory = configPath.slice(0, configPath.lastIndexOf("/"))
  if (directory) Bun.spawnSync(["mkdir", "-p", directory])
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function modelValue(config: WorkflowConfig, path: string): string {
  if (path === "lead_model") return config.lead_model
  if (path === "reviewer_model") return config.reviewer_model
  const [root, area] = path.split(".")
  if (root === "areas" && area && area in config.areas) return config.areas[area as AreaName]
  throw new Error(`Unknown model path ${path}`)
}

async function syncAgentModels(config: WorkflowConfig): Promise<void> {
  for (const [agent, path] of Object.entries(agentModels)) {
    const filePath = `${agentRoot}/${agent}.md`
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      console.error(`warning: agent file not found, skipped: ${filePath}`)
      continue
    }
    const current = await file.text()
    const model = modelValue(config, path)
    const updated = current.match(/^model:\s*.*$/m)
      ? current.replace(/^model:\s*.*$/m, `model: ${model}`)
      : current.replace(/^(mode:\s*.*)$/m, `$1\nmodel: ${model}`)
    if (updated !== current) await Bun.write(filePath, updated)
  }
}

function validModel(value: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(value)
}

async function askModel(rl: ReturnType<typeof createInterface>, label: string, current: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(`${label} [${current}]: `)).trim() || current
    if (validModel(answer)) return answer
    console.log("Use el formato provider/model, por ejemplo openai/gpt-5.6-luna.")
  }
}

async function askChoice<T extends string>(rl: ReturnType<typeof createInterface>, label: string, current: T, choices: readonly T[]): Promise<T> {
  while (true) {
    const answer = (await rl.question(`${label} (${choices.join("/")}) [${current}]: `)).trim() || current
    if (choices.includes(answer as T)) return answer as T
    console.log(`Valor no válido. Opciones: ${choices.join(", ")}.`)
  }
}

async function configure(): Promise<void> {
  const existing = await loadConfig()
  const config = mergeConfig(existing ?? undefined)
  const rl = createInterface({ input, output })
  try {
    console.log("\nContinuous Workflow — configuración independiente\n")
    console.log("Los modelos se aplican únicamente a los agentes workflow-*; el agente por defecto no se modifica.\n")
    config.lead_model = await askModel(rl, "Modelo del Lead", config.lead_model)
    for (const area of Object.keys(config.areas) as AreaName[]) {
      config.areas[area] = await askModel(rl, `Modelo para ${area}`, config.areas[area])
    }
    config.reviewer_model = await askModel(rl, "Modelo del reviewer", config.reviewer_model)
    config.review_policy = await askChoice(rl, "Política de revisión", config.review_policy, ["required", "optional", "disabled"] as const)
    config.consultation_policy = await askChoice(rl, "Política de consultores", config.consultation_policy, ["always", "on-demand"] as const)
    const engram = (await rl.question(`URL de Engram [${config.engram_url}]: `)).trim()
    if (engram) {
      try {
        const parsed = new URL(engram)
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol")
        config.engram_url = engram.replace(/\/$/, "")
      } catch {
        throw new Error("engram_url debe ser una URL http(s) válida")
      }
    }
  } finally {
    rl.close()
  }
  Bun.spawnSync(["mkdir", "-p", `${opencodeRoot}/continuous-workflow`])
  await saveConfig(config)
  await syncAgentModels(config)
  console.log(`\nConfiguración guardada en ${configPath}`)
  console.log("Los modelos de los agentes workflow-* fueron sincronizados.")
}

async function showConfig(): Promise<void> {
  const config = (await loadConfig()) ?? defaults
  console.log(JSON.stringify(config, null, 2))
}

async function runOpenCode(args: string[]): Promise<never> {
  const child = Bun.spawn(["opencode", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(await child.exited)
}

async function doctor(): Promise<void> {
  const config = (await loadConfig()) ?? defaults
  const requiredAgents = Object.keys(agentModels)
  const missing = []
  for (const agent of requiredAgents) if (!(await Bun.file(`${agentRoot}/${agent}.md`).exists())) missing.push(agent)
  const opencodeConfigPath = `${opencodeRoot}/opencode.json`
  let mcpConfig: Record<string, unknown> = {}
  try {
    const parsed = await Bun.file(opencodeConfigPath).json()
    mcpConfig = parsed?.mcp && typeof parsed.mcp === "object" ? parsed.mcp as Record<string, unknown> : {}
  } catch {}
  const mcpMissing = ["engram", "context7", "codegraph"].filter((name) => !mcpConfig[name])
  let healthy = missing.length === 0 && mcpMissing.length === 0 && Boolean(Bun.which("opencode")) && Boolean(Bun.which("engram")) && Boolean(Bun.which("codegraph"))
  console.log(`workflow-ai config: ${configPath} ${await Bun.file(configPath).exists() ? "present" : "not created (defaults active)"}`)
  console.log(`opencode: ${Bun.which("opencode") ? "available" : "MISSING"}`)
  console.log(`engram: ${Bun.which("engram") ? "available" : "MISSING"}`)
  console.log(`codegraph: ${Bun.which("codegraph") ? "available" : "MISSING"}`)
  console.log(`workflow agents: ${missing.length ? `missing ${missing.join(", ")}` : "all present"}`)
  console.log(`MCP registrations: ${mcpMissing.length ? `missing ${mcpMissing.join(", ")}` : "engram, context7, codegraph"}`)
  console.log(`engram_url: ${config.engram_url}`)
  if (Bun.which("opencode")) {
    const version = Bun.spawnSync(["opencode", "--version"])
    console.log(`opencode version: ${version.stdout.toString().trim() || "unknown"}`)
    const debug = Bun.spawnSync(["opencode", "debug", "agent", "workflow-lead"])
    const debugOutput = `${debug.stdout.toString()}\n${debug.stderr.toString()}`
    const compatible = debug.exitCode === 0 && debugOutput.includes('"workflow_state": true')
    console.log(`OpenCode workflow API: ${compatible ? "compatible" : "CHECK REQUIRED"}`)
    healthy = healthy && compatible
  }
  if (!healthy) process.exitCode = 1
}

function usage(): void {
  console.log(`workflow-ai — selectable Continuous Workflow\n\nCommands:\n  configure              Configure models, policies, and Engram endpoint\n  show                   Show the effective configuration\n  start [opencode args]  Start an interactive workflow-lead session\n  run [message..]        Run a non-interactive workflow-lead request\n  status <change-id>     Read persisted workflow status\n  resume <change-id>     Recover/continue a persisted workflow\n  sync                   Reapply configured models to workflow-* agents\n  doctor                 Check installation and compatibility\n\nExamples:\n  workflow-ai configure\n  workflow-ai start --dir /path/to/project\n  workflow-ai run --dir /path/to/project "implement feature X"\n  workflow-ai status feature-x`)
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2)
  if (command === "configure") return configure()
  if (command === "show" || command === "config") return showConfig()
  if (command === "doctor") return doctor()
  if (command === "sync") {
    const config = (await loadConfig()) ?? defaults
    await syncAgentModels(config)
    console.log(`Synchronized workflow agent models from ${configPath}`)
    return
  }
  if (command === "start") return runOpenCode(["--agent", "workflow-lead", ...args])
  if (command === "run") return runOpenCode(["run", "--agent", "workflow-lead", ...args])
  if (command === "status") {
    const change = args[0]
    if (!change) throw new Error("status requiere change-id")
    return runOpenCode(["run", "--agent", "workflow-lead", "--command", "work-status", change])
  }
  if (command === "resume") {
    const change = args[0]
    if (!change) throw new Error("resume requiere change-id")
    return runOpenCode(["run", "--agent", "workflow-lead", "--command", "work-resume", change])
  }
  usage()
}

main().catch((error) => {
  console.error(`workflow-ai: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
