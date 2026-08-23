#!/usr/bin/env bun

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

type AreaName = "discovery" | "architecture" | "frontend" | "backend" | "security" | "reliability"

type WorkflowConfig = {
  schema: "continuous-workflow/config/v1"
  lead_model: string
  lead_variant: string
  areas: Record<AreaName, string>
  area_variants: Record<AreaName, string>
  reviewer_model: string
  reviewer_variant: string
  review_policy: "required" | "optional" | "disabled"
  consultation_policy: "always" | "on-demand"
  engram_url: string
}

type ModelAssignment = {
  path: string
  variantPath: string
  label: string
  description: string
}

type ModelOption = {
  id: string
  variants: string[]
  variantsKnown: boolean
}

const home = process.env.HOME || "/tmp"
const opencodeRoot = process.env.OPENCODE_CONFIG_ROOT || `${home}/.config/opencode`
const configPath = process.env.CONTINUOUS_WORKFLOW_CONFIG || `${opencodeRoot}/continuous-workflow/config.json`
const agentRoot = `${opencodeRoot}/agents`
const workflowRoot = `${opencodeRoot}/continuous-workflow`

const defaults: WorkflowConfig = {
  schema: "continuous-workflow/config/v1",
  lead_model: "openai/gpt-5.6-luna",
  lead_variant: "default",
  areas: {
    discovery: "openai/gpt-5.6-luna",
    architecture: "minimax/MiniMax-M3",
    frontend: "opencode-go/kimi-k2.7-code",
    backend: "openai/gpt-5.6-luna",
    security: "opencode-go/kimi-k2.7-code",
    reliability: "minimax/MiniMax-M3",
  },
  area_variants: {
    discovery: "default",
    architecture: "default",
    frontend: "default",
    backend: "default",
    security: "default",
    reliability: "default",
  },
  reviewer_model: "minimax/MiniMax-M3",
  reviewer_variant: "default",
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

const agentVariants: Record<string, string> = {
  "workflow-lead": "lead_variant",
  "workflow-discovery": "area_variants.discovery",
  "workflow-architecture": "area_variants.architecture",
  "workflow-frontend": "area_variants.frontend",
  "workflow-backend": "area_variants.backend",
  "workflow-security": "area_variants.security",
  "workflow-reliability": "area_variants.reliability",
  "workflow-reviewer": "reviewer_variant",
  "workflow-consultant": "area_variants.discovery",
}

function mergeConfig(value: Partial<WorkflowConfig> | undefined): WorkflowConfig {
  return {
    ...defaults,
    ...(value ?? {}),
    areas: { ...defaults.areas, ...(value?.areas ?? {}) },
    area_variants: { ...defaults.area_variants, ...(value?.area_variants ?? {}) },
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

function variantValue(config: WorkflowConfig, path: string): string {
  if (path === "lead_variant") return config.lead_variant || "default"
  if (path === "reviewer_variant") return config.reviewer_variant || "default"
  const [root, area] = path.split(".")
  if (root === "area_variants" && area && area in config.area_variants) return config.area_variants[area as AreaName] || "default"
  throw new Error(`Unknown variant path ${path}`)
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
    let updated = current.match(/^model:\s*.*$/m)
      ? current.replace(/^model:\s*.*$/m, `model: ${model}`)
      : current.replace(/^(mode:\s*.*)$/m, `$1\nmodel: ${model}`)
    const variant = variantValue(config, agentVariants[agent])
    if (variant && variant !== "default") {
      updated = updated.match(/^variant:\s*.*$/m)
        ? updated.replace(/^variant:\s*.*$/m, `variant: ${variant}`)
        : updated.replace(/^(model:\s*.*)$/m, `$1\nvariant: ${variant}`)
    } else {
      updated = updated.replace(/^variant:\s*.*(?:\r?\n|$)/m, "")
    }
    if (updated !== current) await Bun.write(filePath, updated)
  }
}

function validModel(value: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(value)
}

const modelAssignments: ModelAssignment[] = [
  {
    path: "lead_model",
    variantPath: "lead_variant",
    label: "Lead",
    description: "Es dueño del cambio completo: objetivo, plan, implementación, verificación, recuperación y solicitud de cierre.",
  },
  {
    path: "areas.discovery",
    variantPath: "area_variants.discovery",
    label: "Discovery",
    description: "Mapea el proyecto existente, encuentra código y reglas relevantes e identifica incógnitas antes de implementar.",
  },
  {
    path: "areas.architecture",
    variantPath: "area_variants.architecture",
    label: "Architecture",
    description: "Evalúa límites, dependencias, flujo de datos, trade-offs y el diseño más seguro para el cambio.",
  },
  {
    path: "areas.frontend",
    variantPath: "area_variants.frontend",
    label: "Frontend",
    description: "Asesora sobre comportamiento de UI, estado, accesibilidad, integración cliente y pruebas frontend.",
  },
  {
    path: "areas.backend",
    variantPath: "area_variants.backend",
    label: "Backend",
    description: "Asesora sobre servicios, APIs, persistencia, reglas de negocio, migraciones y pruebas backend.",
  },
  {
    path: "areas.security",
    variantPath: "area_variants.security",
    label: "Security",
    description: "Busca riesgos de privilegios, validación, exposición de datos, dependencias y abuso.",
  },
  {
    path: "areas.reliability",
    variantPath: "area_variants.reliability",
    label: "Reliability",
    description: "Busca fallos, casos límite, observabilidad, recuperación, rendimiento y regresiones.",
  },
  {
    path: "reviewer_model",
    variantPath: "reviewer_variant",
    label: "Reviewer",
    description: "Hace una revisión final independiente centrada en corrección, regresiones, pruebas e impacto para el usuario.",
  },
]

function providerEntries(data: any): any[] {
  const all = Array.isArray(data?.all) ? data.all : Array.isArray(data?.providers) ? data.providers : []
  const connected = Array.isArray(data?.connected) ? new Set(data.connected) : null
  return connected && connected.size ? all.filter((provider: any) => connected.has(provider?.id)) : all
}

function discoverModelIds(currentValues: string[], data: any): string[] {
  const discovered: string[] = []
  const providers = providerEntries(data)
  for (const provider of providers) {
    const providerId = typeof provider?.id === "string" ? provider.id : ""
    if (!providerId || !provider?.models || typeof provider.models !== "object") continue
    for (const key of Object.keys(provider.models)) {
      const model = key.includes("/") ? key : `${providerId}/${key}`
      if (validModel(model)) discovered.push(model)
    }
  }
  return [...new Set([...discovered, ...currentValues])]
}

async function providerDataFromServer(): Promise<any | null> {
  const explicitUrl = process.env.OPENCODE_SERVER_URL?.replace(/\/$/, "")
  if (explicitUrl) {
    try {
      const response = await fetch(`${explicitUrl}/provider`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return await response.json()
    } catch {}
  }

  const binary = Bun.which("opencode")
  if (!binary) return null
  const isolatedConfigRoot = await mkdtemp(`${tmpdir()}/programing-workflow-opencode-`)
  // Reuse the user's OpenCode model/provider declarations in a temporary
  // config root, but do not load the user's plugins. The provider endpoint
  // only reports reasoning variants for models that are declared there.
  const configCandidates = [`${opencodeRoot}/opencode.jsonc`, `${opencodeRoot}/opencode.json`]
  let copiedConfig = false
  for (const sourcePath of configCandidates) {
    if (!(await Bun.file(sourcePath).exists())) continue
    const filename = sourcePath.split("/").pop() as string
    await Bun.write(`${isolatedConfigRoot}/${filename}`, await Bun.file(sourcePath).text())
    copiedConfig = true
    break
  }
  if (!copiedConfig) await Bun.write(`${isolatedConfigRoot}/opencode.json`, '{"$schema":"https://opencode.ai/config.json"}\n')
  // OpenCode 1.18 treats port 0 as its default port instead of asking the OS
  // for an ephemeral port. Reserve a free local port first so an already
  // running OpenCode instance cannot make discovery hit the wrong server.
  let port = 0
  try {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    port = probe.port
    probe.stop(true)
  } catch {}
  if (port === 0) port = 40000 + Math.floor(Math.random() * 20000)
  const serveArgs = [binary, "serve", "--hostname", "127.0.0.1", "--pure"]
  serveArgs.splice(2, 0, "--port", String(port))
  const child = Bun.spawn(serveArgs, {
    cwd: home,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: commandEnv({ OPENCODE_CONFIG_ROOT: isolatedConfigRoot }),
  })
  const serverUrl = `http://127.0.0.1:${port}`
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${serverUrl}/provider`, { signal: AbortSignal.timeout(500) })
        if (response.ok) return await response.json()
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  } catch {
    return null
  } finally {
    child.kill()
    await child.exited
    await rm(isolatedConfigRoot, { recursive: true, force: true })
  }
}

function providerVariants(data: any): Map<string, string[]> {
  const candidates = new Map<string, { provider: string; variants: string[] }>()
  const providers = providerEntries(data)
  for (const provider of providers) {
    const providerId = typeof provider?.id === "string" ? provider.id : ""
    if (!providerId || !provider?.models || typeof provider.models !== "object") continue
    for (const [key, rawModel] of Object.entries(provider.models)) {
      const model = rawModel as { variants?: Record<string, unknown> }
      const id = key.includes("/") ? key : `${providerId}/${key}`
      const variants = Object.keys(model.variants ?? {})
      const prefix = id.split("/", 1)[0]
      const previous = candidates.get(id)
      const exact = providerId === prefix
      if (!previous || (exact && previous.provider !== prefix)) {
        candidates.set(id, { provider: exact ? prefix : providerId, variants })
      }
    }
  }
  return new Map([...candidates.entries()].map(([id, value]) => [id, value.variants]))
}

async function discoverModelCatalog(currentValues: string[]): Promise<ModelOption[]> {
  const data = await providerDataFromServer()
  const ids = discoverModelIds(currentValues, data)
  const variants = providerVariants(data)
  return ids.map((id) => ({ id, variants: variants.get(id) ?? [], variantsKnown: variants.has(id) }))
}

function printModelCatalogSummary(models: ModelOption[]): void {
  if (!models.length) {
    console.log("No se pudo obtener el catálogo de modelos. Puedes usar la opción manual.")
    return
  }
  console.log(`Se detectaron ${models.length} modelos disponibles en OpenCode.`)
  console.log("Busca por nombre o proveedor (por ejemplo: luna, deepseek, kimi, minimax). Escribe ? para ver coincidencias.")
}

function printModelMatches(matches: ModelOption[]): void {
  console.log("Coincidencias:")
  for (const model of matches) {
    const variants = !model.variantsKnown
      ? " — niveles no consultados"
      : model.variants.length
        ? ` — pensamiento: ${model.variants.join(", ")}`
        : " — sin niveles declarados"
    console.log(`  ${model.id}${variants}`)
  }
}

async function askModel(
  rl: ReturnType<typeof createInterface>,
  assignment: ModelAssignment,
  current: string,
  models: ModelOption[],
): Promise<ModelOption> {
  while (true) {
    console.log(`\n${assignment.label}`)
    console.log(`  ${assignment.description}`)
    console.log(`  Actual: ${current}`)
    const answer = (await rl.question("  Busca un modelo, Enter para conservarlo, ? para listar o escribe manual: ")).trim()
    if (!answer) return models.find((model) => model.id === current) ?? { id: current, variants: [], variantsKnown: false }
    if (answer.toLowerCase() === "manual") {
      const manual = (await rl.question("  Modelo (provider/model): ")).trim()
      if (validModel(manual)) return { id: manual, variants: [], variantsKnown: false }
      console.log("  Formato no válido. Usa provider/model, por ejemplo openai/gpt-5.6-luna.")
      continue
    }
    const query = answer === "?" ? "" : answer.toLowerCase()
    const matches = models.filter((model) => !query || model.id.toLowerCase().includes(query))
    const exact = models.find((model) => model.id.toLowerCase() === answer.toLowerCase())
    if (exact) return exact
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      printModelMatches(matches)
      console.log("  Escribe una búsqueda más específica o el identificador completo.")
      continue
    }
    console.log("  No encontré ese modelo. Prueba otra búsqueda o escribe manual.")
  }
}

const thinkingDescriptions: Record<string, string> = {
  default: "Deja que OpenCode y el proveedor usen su configuración predeterminada.",
  none: "Sin razonamiento adicional; prioriza rapidez y menor coste.",
  minimal: "Razonamiento mínimo para tareas directas.",
  low: "Razonamiento ligero para cambios acotados.",
  medium: "Equilibrio entre profundidad, tiempo y coste.",
  high: "Análisis profundo para arquitectura, riesgos y cambios complejos.",
  xhigh: "Análisis muy profundo para problemas difíciles y alta incertidumbre.",
  max: "Nivel máximo que declara el proveedor para este modelo.",
  thinking: "Modo de razonamiento específico declarado por el proveedor.",
}

function describeThinkingLevel(level: string): string {
  return thinkingDescriptions[level] ?? "Nivel específico declarado por el proveedor; su semántica exacta depende del modelo."
}

async function askThinkingLevel(
  rl: ReturnType<typeof createInterface>,
  assignment: ModelAssignment,
  model: ModelOption,
  current: string,
): Promise<string> {
  const supported = ["default", ...model.variants.filter((variant) => variant !== "default")]
  const currentValue = supported.includes(current) ? current : "default"
  console.log(`  Nivel de pensamiento para ${assignment.label} (${model.id})`)
  for (const level of supported) console.log(`    ${level}: ${describeThinkingLevel(level)}`)
  if (!model.variantsKnown) {
    console.log("  OpenCode no publicó variantes para este modelo. Puedes escribir el nombre si tu proveedor admite una.")
    while (true) {
      const answer = (await rl.question(`  Nivel [${currentValue}] (nombre del proveedor, Enter conserva): `)).trim()
      if (!answer) return currentValue
      if (/^[^\s]+$/.test(answer)) return answer
      console.log("  Escribe un único nombre de variante, por ejemplo high o thinking.")
    }
  }
  if (model.variants.length === 0) {
    console.log("  Este modelo no declara variantes de razonamiento; se usará default.")
    return "default"
  }
  while (true) {
    const answer = (await rl.question(`  Nivel [${currentValue}] (escribe el nombre, Enter conserva): `)).trim().toLowerCase()
    if (!answer) return currentValue
    const match = supported.find((level) => level.toLowerCase() === answer)
    if (match) return match
    console.log(`  Nivel no válido. Opciones: ${supported.join(", ")}.`)
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
    const currentModels = modelAssignments.map((assignment) => modelValue(config, assignment.path))
    const models = await discoverModelCatalog(currentModels)
    printModelCatalogSummary(models)
    for (const assignment of modelAssignments) {
      const previousModel = modelValue(config, assignment.path)
      const selected = await askModel(rl, assignment, previousModel, models)
      const previousVariant = selected.id === previousModel ? variantValue(config, assignment.variantPath) : "default"
      const variant = await askThinkingLevel(rl, assignment, selected, previousVariant)
      if (assignment.path === "lead_model") {
        config.lead_model = selected.id
        config.lead_variant = variant
      } else if (assignment.path === "reviewer_model") {
        config.reviewer_model = selected.id
        config.reviewer_variant = variant
      }
      else {
        const area = assignment.path.split(".")[1] as AreaName
        config.areas[area] = selected.id
        config.area_variants[area] = variant
      }
    }
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

function commandEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>
  return { ...env, ...overrides }
}

async function runDependencyScript(name: string, overrides: Record<string, string> = {}): Promise<void> {
  const script = `${workflowRoot}/scripts/${name}`
  if (!(await Bun.file(script).exists())) throw new Error(`dependency script is missing: ${script}; reinstall the workflow bundle`)
  const child = Bun.spawn(["bash", script], { env: commandEnv(overrides), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}

function toolVersion(command: string, args: string[]): string {
  const binary = Bun.which(command)
  if (!binary) return "MISSING"
  const result = Bun.spawnSync([binary, ...args])
  return result.stdout.toString().trim() || result.stderr.toString().trim() || "available"
}

async function dependencyStatus(): Promise<boolean> {
  const opencodeConfigPath = `${opencodeRoot}/opencode.json`
  let mcpConfig: Record<string, unknown> = {}
  try {
    const parsed = await Bun.file(opencodeConfigPath).json()
    mcpConfig = parsed?.mcp && typeof parsed.mcp === "object" ? parsed.mcp as Record<string, unknown> : {}
  } catch {}
  const missingMcp = ["engram", "context7", "codegraph"].filter((name) => !mcpConfig[name])
  console.log(`Engram: ${toolVersion("engram", ["version"])}`)
  console.log(`CodeGraph: ${toolVersion("codegraph", ["--version"])}`)
  console.log(`Context7: ${mcpConfig.context7 ? "MCP remoto configurado" : "MISSING MCP registration"}`)
  console.log(`MCP: ${missingMcp.length ? `missing ${missingMcp.join(", ")}` : "Engram, Context7, CodeGraph configured"}`)
  return Boolean(Bun.which("engram")) && Boolean(Bun.which("codegraph")) && missingMcp.length === 0
}

async function dependencies(command: "install" | "update" | "status"): Promise<void> {
  if (command === "status") {
    if (!(await dependencyStatus())) process.exitCode = 1
    return
  }
  if (command === "install") {
    await runDependencyScript("install-engram.sh")
    await runDependencyScript("install-codegraph.sh")
  } else {
    await runDependencyScript("install-engram.sh", { ENGRAM_UPDATE: "1" })
    await runDependencyScript("install-codegraph.sh", { CODEGRAPH_UPDATE: "1" })
  }
  await runDependencyScript("install-mcp.sh")
  console.log(`Dependencies ${command === "update" ? "updated" : "installed"}.`)
  if (!(await dependencyStatus())) process.exitCode = 1
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
    // Keep the compatibility probe outside the user's project. Existing
    // project plugins may write their own registries when OpenCode starts.
    const debug = Bun.spawnSync(["opencode", "debug", "agent", "workflow-lead"], { cwd: home })
    const debugOutput = `${debug.stdout.toString()}\n${debug.stderr.toString()}`
    const compatible = debug.exitCode === 0 && debugOutput.includes('"workflow_state": true')
    console.log(`OpenCode workflow API: ${compatible ? "compatible" : "CHECK REQUIRED"}`)
    healthy = healthy && compatible
  }
  if (!healthy) process.exitCode = 1
}

function usage(): void {
  console.log(`workflow-ai — selectable Continuous Workflow\n\nCommands:\n  configure              Configure models, policies, and Engram endpoint\n  deps install           Install missing Engram, CodeGraph, and MCP registrations\n  deps update            Update pinned Engram and CodeGraph versions\n  deps status            Show dependency versions and Context7 registration\n  show                   Show the effective configuration\n  start [opencode args]  Start an interactive workflow-lead session\n  run [message..]        Run a non-interactive workflow-lead request\n  status <change-id>     Read persisted workflow status\n  resume <change-id>     Recover/continue a persisted workflow\n  complete <change-id>   Explicitly confirm and close a ready workflow\n  sync                   Reapply configured models to workflow-* agents\n  doctor                 Check installation and compatibility\n\nExamples:\n  workflow-ai configure\n  workflow-ai deps status\n  workflow-ai deps update\n  workflow-ai start --dir /path/to/project\n  workflow-ai run --dir /path/to/project "implement feature X"\n  workflow-ai status feature-x\n  workflow-ai complete feature-x`)
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2)
  if (command === "configure") return configure()
  if (command === "deps" || command === "dependencies") {
    const dependencyCommand = args[0] as "install" | "update" | "status" | undefined
    if (!dependencyCommand || !["install", "update", "status"].includes(dependencyCommand)) throw new Error("deps requiere install, update o status")
    return dependencies(dependencyCommand)
  }
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
  if (command === "complete" || command === "close") {
    const change = args[0]
    if (!change) throw new Error("complete requiere change-id")
    return runOpenCode(["run", "--agent", "workflow-lead", "--command", "work-complete", change])
  }
  usage()
}

main().catch((error) => {
  console.error(`workflow-ai: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
