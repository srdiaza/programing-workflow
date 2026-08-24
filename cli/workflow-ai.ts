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
  console.log("Catálogo de modelos conectado a OpenCode.")
  console.log("Escribe para filtrar; usa ↑/↓ para moverte, Enter para elegir y Tab para introducir un modelo manual.")
}

type PickerResult<T> =
  | { kind: "selected"; value: T }
  | { kind: "manual" }
  | { kind: "cancel" }
  | { kind: "unavailable" }

function interactiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function")
}

async function interactivePicker<T>(options: {
  values: T[]
  current: T
  search: boolean
  allowManual?: boolean
  prompt: string
  matches: (query: string) => T[]
  label: (value: T) => string
  detail?: (value: T) => string
}): Promise<PickerResult<T>> {
  if (!interactiveTerminal()) return { kind: "unavailable" }
  const initialIndex = Math.max(0, options.values.indexOf(options.current))
  let query = ""
  let activeIndex = initialIndex
  let matches = options.matches(query)
  if (!matches.length) matches = options.values
  activeIndex = Math.max(0, matches.indexOf(options.current))
  rlPauseForPicker()
  input.setRawMode(true)
  input.resume()
  return await new Promise<PickerResult<T>>((resolve) => {
    const render = () => {
      const active = matches[activeIndex]
      const searchText = query ? `buscar: ${query}` : `actual: ${options.label(options.current)}`
      const candidate = active ? ` → ${options.label(active)}` : " → sin coincidencias"
      const detail = active && options.detail ? ` — ${options.detail(active)}` : ""
      const navigation = options.allowManual ? "↑↓ mover · Enter elegir · Tab manual · Esc cancelar" : "↑↓ mover · Enter elegir · Esc cancelar"
      output.write(`\r\x1b[2K  ${options.prompt} · ${searchText}${candidate}${detail}  [${navigation}]`)
    }
    const finish = (result: PickerResult<T>) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      output.write("\n")
      rlResumeAfterPicker()
      resolve(result)
    }
    const updateMatches = () => {
      matches = options.matches(query)
      activeIndex = Math.max(0, Math.min(activeIndex, matches.length - 1))
      if (!matches.length) activeIndex = 0
      render()
    }
    const onData = (chunk: Buffer | string) => {
      let data = String(chunk)
      while (data.length) {
        if (data.startsWith("\x1b[A")) {
          if (matches.length) activeIndex = (activeIndex + matches.length - 1) % matches.length
          data = data.slice(3)
        } else if (data.startsWith("\x1b[B")) {
          if (matches.length) activeIndex = (activeIndex + 1) % matches.length
          data = data.slice(3)
        } else if (data.startsWith("\x1b")) {
          finish({ kind: "cancel" })
          return
        } else {
          const char = data[0]
          data = data.slice(1)
          if (char === "\u0003") {
            finish({ kind: "cancel" })
            return
          }
          if (char === "\r" || char === "\n") {
            if (matches[activeIndex]) finish({ kind: "selected", value: matches[activeIndex] })
            return
          }
          if (char === "\t" && options.allowManual) {
            finish({ kind: "manual" })
            return
          }
          if (options.search && (char === "\u007f" || char === "\b")) {
            query = query.slice(0, -1)
            updateMatches()
            continue
          }
          if (options.search && char >= " " && char !== "\u007f") {
            query += char
            activeIndex = 0
            updateMatches()
            continue
          }
        }
        render()
      }
    }
    input.on("data", onData)
    render()
  })
}

function rlPauseForPicker(): void {
  // readline has a data listener even between questions; pausing it prevents
  // the picker keystrokes from being consumed twice.
  input.pause()
}

function rlResumeAfterPicker(): void {
  input.resume()
}

async function askModel(
  rl: ReturnType<typeof createInterface>,
  assignment: ModelAssignment,
  current: string,
  models: ModelOption[],
): Promise<ModelOption> {
  console.log(`\n${assignment.label}`)
  console.log(`  ${assignment.description}`)
  console.log(`  Actual: ${current}`)
  const currentOption = models.find((model) => model.id === current) ?? { id: current, variants: [], variantsKnown: false }
  const picked = await interactivePicker<ModelOption>({
    values: models,
    current: currentOption,
    search: true,
    allowManual: true,
    prompt: "Modelo",
    matches: (query) => models.filter((model) => !query || model.id.toLowerCase().includes(query.toLowerCase())),
    label: (model) => model.id,
    detail: (model) => !model.variantsKnown ? "variantes no consultadas" : model.variants.length ? `pensamiento: ${model.variants.join(", ")}` : "sin niveles declarados",
  })
  if (picked.kind === "selected") return picked.value
  if (picked.kind === "cancel") return currentOption
  if (picked.kind === "manual") {
    while (true) {
      const manual = (await rl.question("  Modelo manual (provider/model): ")).trim()
      if (validModel(manual)) return { id: manual, variants: [], variantsKnown: false }
      console.log("  Formato no válido. Usa provider/model, por ejemplo openai/gpt-5.6-luna.")
    }
  }
  if (picked.kind === "unavailable") {
    while (true) {
      const answer = (await rl.question("  Modelo (búsqueda, Enter conserva, manual escribe otro): ")).trim()
      if (!answer) return currentOption
      if (answer.toLowerCase() === "manual") continue
      const matches = models.filter((model) => model.id.toLowerCase().includes(answer.toLowerCase()))
      const exact = models.find((model) => model.id.toLowerCase() === answer.toLowerCase())
      if (exact || matches.length === 1) return exact ?? matches[0]
      if (matches.length > 1) console.log("  Hay varias coincidencias; escribe una búsqueda más específica.")
      else console.log("  No encontré ese modelo. Prueba otra búsqueda o escribe manual.")
    }
  }
  return currentOption
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
  const picked = await interactivePicker<string>({
    values: supported,
    current: currentValue,
    search: false,
    prompt: "Pensamiento",
    matches: () => supported,
    label: (level) => level,
    detail: (level) => describeThinkingLevel(level),
  })
  if (picked.kind === "unavailable") {
    while (true) {
      const answer = (await rl.question(`  Nivel [${currentValue}] (nombre, Enter conserva): `)).trim().toLowerCase()
      if (!answer) return currentValue
      const match = supported.find((level) => level.toLowerCase() === answer)
      if (match) return match
      console.log(`  Nivel no válido. Prueba una de las variantes admitidas por el modelo.`)
    }
  }
  return picked.kind === "selected" ? picked.value : currentValue
}

async function askChoice<T extends string>(rl: ReturnType<typeof createInterface>, label: string, current: T, choices: readonly T[]): Promise<T> {
  while (true) {
    const answer = (await rl.question(`${label} (${choices.join("/")}) [${current}]: `)).trim() || current
    if (choices.includes(answer as T)) return answer as T
    console.log(`Valor no válido. Opciones: ${choices.join(", ")}.`)
  }
}

type TuiMode = "main" | "model" | "variant" | "manual-model" | "manual-variant" | "policies" | "review"
type TuiKey = "up" | "down" | "left" | "right" | "enter" | "tab" | "backspace" | "escape" | { kind: "char"; value: string } | "cancel"

type TuiState = {
  mode: TuiMode
  config: WorkflowConfig
  original: WorkflowConfig
  models: ModelOption[]
  selected: number
  modelQuery: string
  modelCursor: number
  variantCursor: number
  pendingModel: string
  pendingOption: ModelOption | null
  pendingVariant: string
  manualInput: string
  policyCursor: number
  policyEditing: boolean
  policyChoice: number
  status: string
}

const tuiEscape = "\x1b["
const tuiReset = "\x1b[0m"
const tuiCyan = (value: string) => `${tuiEscape}36m${value}${tuiReset}`
const tuiBlue = (value: string) => `${tuiEscape}44;97m${value}${tuiReset}`
const tuiBold = (value: string) => `${tuiEscape}1m${value}${tuiReset}`
const tuiDim = (value: string) => `${tuiEscape}2m${value}${tuiReset}`
const tuiYellow = (value: string) => `${tuiEscape}33m${value}${tuiReset}`
const tuiGreen = (value: string) => `${tuiEscape}32m${value}${tuiReset}`

const tuiPolicyItems = [
  { key: "review_policy", label: "Revisión", choices: ["required", "optional", "disabled"] as const },
  { key: "consultation_policy", label: "Consultores", choices: ["always", "on-demand"] as const },
]

function tuiInteractive(): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function")
}

function tuiPlain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "")
}

function tuiFit(value: string, width: number): string {
  const plain = tuiPlain(value)
  if (plain.length > width) return `${plain.slice(0, Math.max(0, width - 1))}…`.padEnd(width)
  return value + " ".repeat(Math.max(0, width - plain.length))
}

function tuiWrap(value: string, width: number): string[] {
  const words = value.split(/\s+/)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!word) continue
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

function tuiClone(config: WorkflowConfig): WorkflowConfig {
  return JSON.parse(JSON.stringify(config)) as WorkflowConfig
}

function tuiDirty(state: TuiState): boolean {
  return JSON.stringify(state.config) !== JSON.stringify(state.original)
}

function tuiAssignments(): ModelAssignment[] {
  return modelAssignments
}

function tuiSetModel(config: WorkflowConfig, path: string, value: string): void {
  if (path === "lead_model") config.lead_model = value
  else if (path === "reviewer_model") config.reviewer_model = value
  else config.areas[path.split(".")[1] as AreaName] = value
}

function tuiSetVariant(config: WorkflowConfig, path: string, value: string): void {
  if (path === "lead_variant") config.lead_variant = value
  else if (path === "reviewer_variant") config.reviewer_variant = value
  else config.area_variants[path.split(".")[1] as AreaName] = value
}

function tuiModelMatches(state: TuiState): ModelOption[] {
  const query = state.modelQuery.toLowerCase()
  return state.models.filter((model) => !query || model.id.toLowerCase().includes(query))
}

function tuiVariantChoices(state: TuiState): string[] {
  const option = state.pendingOption
  if (!option) return ["default"]
  const choices = ["default", ...option.variants.filter((variant) => variant !== "default")]
  if (!option.variantsKnown) {
    if (state.pendingVariant !== "default" && !choices.includes(state.pendingVariant)) choices.push(state.pendingVariant)
    choices.push("custom…")
  }
  return [...new Set(choices)]
}

function tuiCurrentPolicy(state: TuiState): string {
  const item = tuiPolicyItems[state.policyCursor]
  return item.key === "review_policy" ? state.config.review_policy : state.config.consultation_policy
}

function tuiSetPolicy(state: TuiState, value: string): void {
  const item = tuiPolicyItems[state.policyCursor]
  if (item.key === "review_policy") state.config.review_policy = value as WorkflowConfig["review_policy"]
  else state.config.consultation_policy = value as WorkflowConfig["consultation_policy"]
}

function tuiParseKeys(raw: string): TuiKey[] {
  const keys: TuiKey[] = []
  let data = raw
  while (data.length) {
    if (data.startsWith("\x1b[A")) { keys.push("up"); data = data.slice(3); continue }
    if (data.startsWith("\x1b[B")) { keys.push("down"); data = data.slice(3); continue }
    if (data.startsWith("\x1b[C")) { keys.push("right"); data = data.slice(3); continue }
    if (data.startsWith("\x1b[D")) { keys.push("left"); data = data.slice(3); continue }
    const char = data[0]
    data = data.slice(1)
    if (char === "\u0003") keys.push("cancel")
    else if (char === "\r" || char === "\n") keys.push("enter")
    else if (char === "\t") keys.push("tab")
    else if (char === "\u007f" || char === "\b") keys.push("backspace")
    else if (char === "\x1b") keys.push("escape")
    else keys.push({ kind: "char", value: char })
  }
  return keys
}

function tuiHeader(state: TuiState): string {
  const dirty = tuiDirty(state) ? tuiYellow(" • CAMBIOS SIN GUARDAR") : tuiDim(" • sin cambios")
  return `${tuiBold("PROGRAMING WORKFLOW")}  ${tuiCyan("Configuración")}${dirty}`
}

function tuiLeftLines(state: TuiState): string[] {
  const lines = [tuiBold("SECCIONES"), ""]
  const labels = [...tuiAssignments().map((assignment) => assignment.label), "Políticas", "Revisar y guardar"]
  for (let index = 0; index < labels.length; index += 1) {
    const active = state.mode === "policies" ? index === tuiAssignments().length : state.mode === "review" ? index === tuiAssignments().length + 1 : state.selected === index
    lines.push(active ? tuiBlue(`  ▸ ${labels[index]}`) : `    ${labels[index]}`)
  }
  lines.push("", tuiDim("Configuración independiente"), tuiDim("No modifica el agente normal"))
  return lines
}

function tuiAssignmentDetails(state: TuiState, assignment: ModelAssignment, width: number): string[] {
  const model = modelValue(state.config, assignment.path)
  const variant = variantValue(state.config, assignment.variantPath)
  const lines = [tuiBold(assignment.label), ""]
  lines.push(...tuiWrap(assignment.description, width), "")
  lines.push(`${tuiCyan("Modelo")}      ${model}`)
  lines.push(`${tuiCyan("Pensamiento")} ${variant === "default" ? "predeterminado" : variant}`)
  lines.push("", tuiDim("Enter editar modelo · ↑↓ cambiar sección"))
  return lines
}

function tuiModelDetails(state: TuiState, width: number, height: number): string[] {
  const assignment = tuiAssignments()[state.selected]
  const matches = tuiModelMatches(state)
  const lines = [tuiBold(`Modelo para ${assignment.label}`), "", `${tuiCyan("Buscar")} ${state.modelQuery || tuiDim("escribe para filtrar")}`, ""]
  if (!matches.length) {
    lines.push(tuiYellow("No hay coincidencias."), "", "Tab abre el modelo manual.")
    return lines
  }
  const visible = Math.max(4, height - 8)
  const start = Math.max(0, Math.min(state.modelCursor - Math.floor(visible / 2), matches.length - visible))
  for (const [offset, model] of matches.slice(start, start + visible).entries()) {
    const index = start + offset
    const active = index === state.modelCursor
    const detail = !model.variantsKnown ? "variantes no consultadas" : model.variants.length ? `pensamiento: ${model.variants.join(", ")}` : "sin niveles declarados"
    lines.push(active ? tuiBlue(`  ▸ ${model.id}`) : `    ${model.id}`)
    lines.push(active ? `      ${tuiDim(detail)}` : `      ${tuiDim(detail)}`)
  }
  lines.push("", tuiDim("↑↓ mover · Enter seleccionar · Tab modelo manual · Esc volver"))
  return lines
}

function tuiVariantDetails(state: TuiState, width: number): string[] {
  const assignment = tuiAssignments()[state.selected]
  const option = state.pendingOption
  const choices = tuiVariantChoices(state)
  const lines = [tuiBold(`Pensamiento para ${assignment.label}`), "", `Modelo: ${state.pendingModel}`, ""]
  if (option && !option.variantsKnown) lines.push(tuiYellow("El proveedor no publicó sus variantes. Puedes definir una manualmente."), "")
  for (const [index, choice] of choices.entries()) {
    const active = index === state.variantCursor
    const description = choice === "custom…" ? "Escribir una variante del proveedor" : describeThinkingLevel(choice)
    lines.push(active ? tuiBlue(`  ▸ ${choice}`) : `    ${choice}`, `      ${tuiDim(description)}`)
  }
  lines.push("", tuiDim("↑↓ mover · Enter seleccionar · c variante manual · Esc volver"))
  return lines
}

function tuiManualDetails(state: TuiState, title: string, help: string): string[] {
  return [tuiBold(title), "", tuiCyan("Entrada"), `${state.manualInput}▌`, "", tuiDim(help), "", tuiDim("Enter aceptar · Esc cancelar")]
}

function tuiPolicyDetails(state: TuiState): string[] {
  const lines = [tuiBold("Políticas del workflow"), "", "Engram", "  automático · se conserva la URL configurada", ""]
  tuiPolicyItems.forEach((item, index) => {
    const current = tuiCurrentPolicy({ ...state, policyCursor: index })
    const active = index === state.policyCursor
    lines.push(active ? tuiBlue(`  ▸ ${item.label}: ${current}`) : `    ${item.label}: ${current}`)
    if (active && state.policyEditing) {
      for (const [choiceIndex, choice] of item.choices.entries()) lines.push(choiceIndex === state.policyChoice ? `      ${tuiCyan("●")} ${choice}` : `      ○ ${choice}`)
    }
  })
  lines.push("", tuiDim(state.policyEditing ? "↑↓ elegir · Enter confirmar · Esc cancelar" : "↑↓ mover · Enter editar · Esc volver"))
  return lines
}

function tuiReviewDetails(state: TuiState, width: number): string[] {
  const lines = [tuiBold("Revisar configuración"), "", tuiDim("Nada se guarda hasta confirmar aquí."), ""]
  for (const assignment of tuiAssignments()) {
    const model = modelValue(state.config, assignment.path)
    const variant = variantValue(state.config, assignment.variantPath)
    lines.push(`${tuiCyan(assignment.label.padEnd(13))} ${model}  ·  ${variant}`)
  }
  lines.push("", `${tuiCyan("Revisión")}      ${state.config.review_policy}`, `${tuiCyan("Consultores")}   ${state.config.consultation_policy}`, "", tuiGreen("Enter guardar"), tuiDim("Esc volver · q cancelar"))
  return lines
}

function tuiRender(state: TuiState): void {
  const columns = Number(output.columns) || 100
  const rows = Number(output.rows) || 30
  const width = Math.max(70, Math.min(columns, 128))
  const height = Math.max(22, Math.min(rows, 48))
  const leftWidth = Math.min(30, Math.floor(width * 0.29))
  const rightWidth = width - leftWidth - 3
  const bodyHeight = height - 7
  const top = `╭${"─".repeat(width - 2)}╮`
  const divider = `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`
  const bottom = `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`
  const right = state.mode === "model"
    ? tuiModelDetails(state, rightWidth, bodyHeight)
    : state.mode === "variant"
      ? tuiVariantDetails(state, rightWidth)
      : state.mode === "manual-model"
        ? tuiManualDetails(state, "Modelo manual", "Usa provider/model; por ejemplo openai/gpt-5.6-luna")
        : state.mode === "manual-variant"
          ? tuiManualDetails(state, "Variante manual", "Escribe el nombre que acepta tu proveedor; por ejemplo thinking")
          : state.mode === "policies"
            ? tuiPolicyDetails(state)
            : state.mode === "review"
              ? tuiReviewDetails(state, rightWidth)
              : state.selected < tuiAssignments().length
                ? tuiAssignmentDetails(state, tuiAssignments()[state.selected], rightWidth)
                : [tuiBold("Selecciona una sección"), "", tuiDim("Usa ↑↓ para moverte y Enter para abrirla.")]
  const left = tuiLeftLines(state)
  const content: string[] = [top, `│${tuiFit(tuiHeader(state), width - 2)}│`, divider]
  for (let index = 0; index < bodyHeight; index += 1) content.push(`│${tuiFit(left[index] ?? "", leftWidth)}│${tuiFit(right[index] ?? "", rightWidth)}│`)
  content.push(divider.replace("┬", "┴").replace("┤", "┤"))
  content.push(`│${tuiFit(state.status || "", width - 2)}│`)
  content.push(`│${tuiFit(tuiDim("↑↓ navegar  Enter abrir  Tab/manual editar  s revisar  q cancelar"), width - 2)}│`)
  content.push(bottom)
  output.write(`${tuiEscape}H${tuiEscape}2J${content.join("\n")}`)
}

function tuiStartEditing(state: TuiState): void {
  const assignment = tuiAssignments()[state.selected]
  state.pendingModel = modelValue(state.config, assignment.path)
  state.pendingOption = state.models.find((model) => model.id === state.pendingModel) ?? { id: state.pendingModel, variants: [], variantsKnown: false }
  state.pendingVariant = variantValue(state.config, assignment.variantPath)
  state.modelQuery = ""
  state.modelCursor = Math.max(0, tuiModelMatches(state).findIndex((model) => model.id === state.pendingModel))
  state.mode = "model"
}

function tuiCommitPending(state: TuiState): void {
  const assignment = tuiAssignments()[state.selected]
  tuiSetModel(state.config, assignment.path, state.pendingModel)
  tuiSetVariant(state.config, assignment.variantPath, state.pendingVariant || "default")
  state.status = `${assignment.label} actualizado. Revisa y guarda cuando estés listo.`
  state.mode = "main"
}

function tuiHandleKey(state: TuiState, key: TuiKey): "save" | "cancel" | null {
  if (key === "cancel") return "cancel"
  if (state.mode === "main") {
    if (key === "up") state.selected = (state.selected + tuiAssignments().length + 1) % (tuiAssignments().length + 2)
    else if (key === "down" || key === "tab") state.selected = (state.selected + 1) % (tuiAssignments().length + 2)
    else if (key === "escape") return "cancel"
    else if (key === "enter") {
      if (state.selected < tuiAssignments().length) tuiStartEditing(state)
      else if (state.selected === tuiAssignments().length) { state.mode = "policies"; state.policyCursor = 0 }
      else state.mode = "review"
    } else if (typeof key === "object" && key.kind === "char" && key.value.toLowerCase() === "s") state.mode = "review"
    else if (typeof key === "object" && key.kind === "char" && key.value.toLowerCase() === "q") return "cancel"
    return null
  }
  if (state.mode === "model") {
    const matches = tuiModelMatches(state)
    if (key === "up" && matches.length) state.modelCursor = (state.modelCursor + matches.length - 1) % matches.length
    else if (key === "down" && matches.length) state.modelCursor = (state.modelCursor + 1) % matches.length
    else if (key === "escape") state.mode = "main"
    else if (key === "tab") { state.manualInput = ""; state.mode = "manual-model" }
    else if (key === "backspace") { state.modelQuery = state.modelQuery.slice(0, -1); state.modelCursor = 0 }
    else if (key === "enter" && matches[state.modelCursor]) {
      const chosen = matches[state.modelCursor]
      state.pendingModel = chosen.id
      state.pendingOption = chosen
      if (chosen.id !== modelValue(state.config, tuiAssignments()[state.selected].path)) state.pendingVariant = "default"
      state.variantCursor = Math.max(0, tuiVariantChoices(state).indexOf(state.pendingVariant))
      state.mode = "variant"
    } else if (typeof key === "object" && key.kind === "char" && key.value >= " ") { state.modelQuery += key.value; state.modelCursor = 0 }
    return null
  }
  if (state.mode === "variant") {
    const choices = tuiVariantChoices(state)
    if (key === "up" && choices.length) state.variantCursor = (state.variantCursor + choices.length - 1) % choices.length
    else if (key === "down" && choices.length) state.variantCursor = (state.variantCursor + 1) % choices.length
    else if (key === "escape") state.mode = "main"
    else if (key === "enter" && choices[state.variantCursor]) {
      if (choices[state.variantCursor] === "custom…") { state.manualInput = state.pendingVariant === "default" ? "" : state.pendingVariant; state.mode = "manual-variant" }
      else { state.pendingVariant = choices[state.variantCursor]; tuiCommitPending(state) }
    } else if (typeof key === "object" && key.kind === "char" && key.value.toLowerCase() === "c" && !state.pendingOption?.variantsKnown) { state.manualInput = ""; state.mode = "manual-variant" }
    return null
  }
  if (state.mode === "manual-model") {
    if (key === "escape") state.mode = "model"
    else if (key === "backspace") state.manualInput = state.manualInput.slice(0, -1)
    else if (key === "enter") {
      if (validModel(state.manualInput)) {
        state.pendingModel = state.manualInput
        state.pendingOption = { id: state.manualInput, variants: [], variantsKnown: false }
        state.pendingVariant = "default"
        state.variantCursor = 0
        state.mode = "variant"
      } else state.status = "Formato inválido. Usa provider/model."
    } else if (typeof key === "object" && key.kind === "char" && key.value >= " ") state.manualInput += key.value
    return null
  }
  if (state.mode === "manual-variant") {
    if (key === "escape") state.mode = "variant"
    else if (key === "backspace") state.manualInput = state.manualInput.slice(0, -1)
    else if (key === "enter") {
      if (/^\S+$/.test(state.manualInput)) { state.pendingVariant = state.manualInput; tuiCommitPending(state) }
      else state.status = "Escribe un nombre de variante."
    } else if (typeof key === "object" && key.kind === "char" && key.value >= " ") state.manualInput += key.value
    return null
  }
  if (state.mode === "policies") {
    const item = tuiPolicyItems[state.policyCursor]
    if (state.policyEditing) {
      if (key === "up" || key === "left") state.policyChoice = (state.policyChoice + item.choices.length - 1) % item.choices.length
      else if (key === "down" || key === "right") state.policyChoice = (state.policyChoice + 1) % item.choices.length
      else if (key === "enter") { tuiSetPolicy(state, item.choices[state.policyChoice]); state.policyEditing = false; state.status = `${item.label} actualizado.` }
      else if (key === "escape") state.policyEditing = false
    } else if (key === "up") state.policyCursor = (state.policyCursor + tuiPolicyItems.length - 1) % tuiPolicyItems.length
    else if (key === "down") state.policyCursor = (state.policyCursor + 1) % tuiPolicyItems.length
    else if (key === "enter") { state.policyChoice = tuiPolicyItems[state.policyCursor].choices.indexOf(tuiCurrentPolicy(state) as never); state.policyEditing = true }
    else if (key === "escape") state.mode = "main"
    return null
  }
  if (state.mode === "review") {
    if (key === "enter" || (typeof key === "object" && key.kind === "char" && key.value.toLowerCase() === "s")) return "save"
    if (key === "escape") state.mode = "main"
    if (typeof key === "object" && key.kind === "char" && key.value.toLowerCase() === "q") return "cancel"
  }
  return null
}

async function runConfigureTui(config: WorkflowConfig, models: ModelOption[]): Promise<WorkflowConfig | null> {
  if (!tuiInteractive()) throw new Error("workflow-ai configure requiere una terminal interactiva")
  const state: TuiState = {
    mode: "main", config: tuiClone(config), original: tuiClone(config), models, selected: 0,
    modelQuery: "", modelCursor: 0, variantCursor: 0, pendingModel: "", pendingOption: null,
    pendingVariant: "default", manualInput: "", policyCursor: 0, policyEditing: false, policyChoice: 0,
    status: "Los cambios se aplican solo después de Guardar.",
  }
  input.setRawMode(true)
  input.resume()
  output.write(`${tuiEscape}?1049h${tuiEscape}?25l`)
  return await new Promise<WorkflowConfig | null>((resolve) => {
    const finish = (value: WorkflowConfig | null) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      output.write(`${tuiEscape}?25h${tuiEscape}?1049l`)
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      for (const key of tuiParseKeys(String(chunk))) {
        const result = tuiHandleKey(state, key)
        if (result === "save") { finish(state.config); return }
        if (result === "cancel") { finish(null); return }
      }
      tuiRender(state)
    }
    input.on("data", onData)
    tuiRender(state)
  })
}

async function configure(): Promise<void> {
  const existing = await loadConfig()
  const config = mergeConfig(existing ?? undefined)
  console.log("Preparando el catálogo de modelos…")
  const currentModels = modelAssignments.map((assignment) => modelValue(config, assignment.path))
  const models = await discoverModelCatalog(currentModels)
  const configured = await runConfigureTui(config, models)
  if (!configured) {
    console.log("Configuración cancelada. No se guardaron cambios.")
    return
  }
  const finalConfig = configured
  Bun.spawnSync(["mkdir", "-p", `${opencodeRoot}/continuous-workflow`])
  await saveConfig(finalConfig)
  await syncAgentModels(finalConfig)
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
