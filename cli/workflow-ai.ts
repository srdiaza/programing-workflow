#!/usr/bin/env bun

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

type AreaName = "discovery" | "architecture" | "frontend" | "backend" | "security" | "reliability"
type PermissionMode = "allow" | "ask" | "deny"

type WorkflowPermissions = {
  edit: PermissionMode
  bash: PermissionMode
  git_push: "ask" | "deny"
  question: "allow" | "deny"
  task: PermissionMode
  external_directory: PermissionMode
}

type WorkflowProfile = {
  description: string
  lead_model: string
  lead_variant: string
  areas: Record<AreaName, string>
  area_variants: Record<AreaName, string>
  reviewer_model: string
  reviewer_variant: string
  review_policy: "required" | "optional" | "disabled"
  consultation_policy: "always" | "on-demand"
  engram_url: string
  permissions: WorkflowPermissions
}

type WorkflowProfileOverrides = Partial<Omit<WorkflowProfile, "areas" | "area_variants" | "permissions">> & {
  areas?: Partial<Record<AreaName, string>>
  area_variants?: Partial<Record<AreaName, string>>
  permissions?: Partial<WorkflowPermissions>
}

type WorkflowConfig = WorkflowProfile & {
  schema: "continuous-workflow/config/v1"
  profiles: Record<string, WorkflowProfileOverrides>
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
const workflowStateDirectory = process.env.CONTINUOUS_WORKFLOW_STATE_DIR || `${home}/.local/share/opencode/continuous-workflow`

const defaults: WorkflowConfig = {
  schema: "continuous-workflow/config/v1",
  description: "Perfil normal del workflow; Lead Luna con especialistas configurados por área.",
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
  permissions: {
    edit: "allow",
    bash: "ask",
    git_push: "ask",
    question: "allow",
    task: "allow",
    external_directory: "ask",
  },
  profiles: {},
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

function validProfileName(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,39}$/.test(value) && value !== "default"
}

function mergeConfig(value: Partial<WorkflowConfig> | undefined): WorkflowConfig {
  const configuredPermissions = value?.permissions as Partial<WorkflowPermissions> | undefined
  const permission = (candidate: unknown, fallback: PermissionMode): PermissionMode => candidate === "allow" || candidate === "ask" || candidate === "deny" ? candidate : fallback
  const questionPermission = configuredPermissions?.question === "deny" ? "deny" : "allow"
  const configuredProfiles = value?.profiles && typeof value.profiles === "object" ? value.profiles : {}
  const profiles: Record<string, WorkflowProfileOverrides> = {}
  for (const [name, profile] of Object.entries(configuredProfiles as Record<string, unknown>)) {
    if (!validProfileName(name) || !profile || typeof profile !== "object") continue
    profiles[name] = profile as WorkflowProfileOverrides
  }
  return {
    ...defaults,
    ...(value ?? {}),
    description: typeof value?.description === "string" && value.description.trim() ? value.description : defaults.description,
    areas: { ...defaults.areas, ...(value?.areas ?? {}) },
    area_variants: { ...defaults.area_variants, ...(value?.area_variants ?? {}) },
    permissions: {
      edit: permission(configuredPermissions?.edit, defaults.permissions.edit),
      bash: permission(configuredPermissions?.bash, defaults.permissions.bash),
      git_push: configuredPermissions?.git_push === "deny" ? "deny" : "ask",
      question: questionPermission,
      task: permission(configuredPermissions?.task, defaults.permissions.task),
      external_directory: permission(configuredPermissions?.external_directory, defaults.permissions.external_directory),
    },
    profiles,
  }
}

function defaultProfile(config: WorkflowConfig): WorkflowProfile {
  const { schema: _schema, profiles: _profiles, ...profile } = config
  return profile
}

function mergeProfile(base: WorkflowProfile, overrides: WorkflowProfileOverrides | undefined): WorkflowProfile {
  const permissions = overrides?.permissions ?? {}
  return {
    ...base,
    lead_model: typeof overrides?.lead_model === "string" && overrides.lead_model.trim() ? overrides.lead_model : base.lead_model,
    lead_variant: typeof overrides?.lead_variant === "string" && overrides.lead_variant.trim() ? overrides.lead_variant : base.lead_variant,
    description: typeof overrides?.description === "string" && overrides.description.trim() ? overrides.description : base.description,
    areas: { ...base.areas, ...(overrides?.areas ?? {}) },
    area_variants: { ...base.area_variants, ...(overrides?.area_variants ?? {}) },
    reviewer_model: typeof overrides?.reviewer_model === "string" && overrides.reviewer_model.trim() ? overrides.reviewer_model : base.reviewer_model,
    reviewer_variant: typeof overrides?.reviewer_variant === "string" && overrides.reviewer_variant.trim() ? overrides.reviewer_variant : base.reviewer_variant,
    review_policy: overrides?.review_policy === "required" || overrides?.review_policy === "optional" || overrides?.review_policy === "disabled" ? overrides.review_policy : base.review_policy,
    consultation_policy: overrides?.consultation_policy === "always" || overrides?.consultation_policy === "on-demand" ? overrides.consultation_policy : base.consultation_policy,
    engram_url: typeof overrides?.engram_url === "string" && overrides.engram_url.trim() ? overrides.engram_url : base.engram_url,
    permissions: {
      ...base.permissions,
      ...permissions,
      edit: permissions.edit === "allow" || permissions.edit === "ask" || permissions.edit === "deny" ? permissions.edit : base.permissions.edit,
      bash: permissions.bash === "allow" || permissions.bash === "ask" || permissions.bash === "deny" ? permissions.bash : base.permissions.bash,
      git_push: permissions.git_push === "deny" ? "deny" : permissions.git_push === "ask" ? "ask" : base.permissions.git_push,
      question: permissions.question === "deny" ? "deny" : permissions.question === "allow" ? "allow" : base.permissions.question,
      task: permissions.task === "allow" || permissions.task === "ask" || permissions.task === "deny" ? permissions.task : base.permissions.task,
      external_directory: permissions.external_directory === "allow" || permissions.external_directory === "ask" || permissions.external_directory === "deny" ? permissions.external_directory : base.permissions.external_directory,
    },
  }
}

function profileConfig(config: WorkflowConfig, name: string): WorkflowProfile {
  if (name === "default") return defaultProfile(config)
  const overrides = config.profiles[name]
  if (!overrides) throw new Error(`Unknown workflow profile: ${name}`)
  return mergeProfile(defaultProfile(config), overrides)
}

function profileAgentName(base: string, profile: string): string {
  return profile === "default" ? base : `${base}-${profile}`
}

const profileAgentBases = [
  "workflow-lead",
  "workflow-consultant",
  "workflow-reviewer",
  "workflow-discovery",
  "workflow-architecture",
  "workflow-frontend",
  "workflow-backend",
  "workflow-security",
  "workflow-reliability",
]

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

function modelValue(config: WorkflowProfile, path: string): string {
  if (path === "lead_model") return config.lead_model
  if (path === "reviewer_model") return config.reviewer_model
  const [root, area] = path.split(".")
  if (root === "areas" && area && area in config.areas) return config.areas[area as AreaName]
  throw new Error(`Unknown model path ${path}`)
}

function variantValue(config: WorkflowProfile, path: string): string {
  if (path === "lead_variant") return config.lead_variant || "default"
  if (path === "reviewer_variant") return config.reviewer_variant || "default"
  const [root, area] = path.split(".")
  if (root === "area_variants" && area && area in config.area_variants) return config.area_variants[area as AreaName] || "default"
  throw new Error(`Unknown variant path ${path}`)
}

async function syncAgentModels(config: WorkflowConfig): Promise<void> {
  await syncProfileAgentModels(defaultProfile(config), "default")
  for (const profile of Object.keys(config.profiles)) {
    await syncProfileAgentModels(profileConfig(config, profile), profile)
  }
}

async function syncProfileAgentModels(profile: WorkflowProfile, profileName: string): Promise<void> {
  for (const [agent, path] of Object.entries(agentModels)) {
    const filePath = `${agentRoot}/${profileAgentName(agent, profileName)}.md`
    const file = Bun.file(filePath)
    if (profileName !== "default") {
      const basePath = `${agentRoot}/${agent}.md`
      if (!(await Bun.file(basePath).exists())) {
        console.error(`warning: profile template not found, skipped: ${basePath}`)
        continue
      }
      // Profile agents are generated artifacts. Re-clone their role template
      // on every sync so upgrades and repeated syncs never accumulate suffixes.
      await Bun.write(filePath, await Bun.file(basePath).text())
    } else if (!(await file.exists())) {
      console.error(`warning: agent file not found, skipped: ${filePath}`)
      continue
    }
    const current = await file.text()
    const model = modelValue(profile, path)
    let updated = current.match(/^model:\s*.*$/m)
      ? current.replace(/^model:\s*.*$/m, `model: ${model}`)
      : current.replace(/^(mode:\s*.*)$/m, `$1\nmodel: ${model}`)
    const variant = variantValue(profile, agentVariants[agent])
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

const workflowSubagents = [
  "workflow-consultant",
  "workflow-reviewer",
  "workflow-discovery",
  "workflow-architecture",
  "workflow-frontend",
  "workflow-backend",
  "workflow-security",
  "workflow-reliability",
]

function markedBlock(content: string, start: string, end: string, replacement: string): string {
  const pattern = new RegExp(`(^\\s*# ${start}\\r?\\n)[\\s\\S]*?(^\\s*# ${end}\\s*$)`, "m")
  if (!pattern.test(content)) throw new Error(`workflow-lead is missing permission markers: ${start}/${end}`)
  return content.replace(pattern, `$1${replacement}\n$2`)
}

function bashPermissionBlock(mode: PermissionMode, gitPush: "ask" | "deny"): string {
  const lines = ["  bash:", `    \"*\": ${mode}`]
  if (mode !== "deny") {
    lines.push(
      `    "git *": ${mode}`,
      '    "git status": allow',
      '    "git diff": allow',
      '    "git diff *": allow',
      '    "git log *": allow',
      '    "git rev-parse *": allow',
    )
  }
  lines.push(
    `    "git push*": ${mode === "deny" ? "deny" : gitPush}`,
    '    "git reset --hard*": deny',
    '    "git clean -fd*": deny',
    '    "rm -rf*": deny',
    '    "sudo *": deny',
  )
  return lines.join("\n")
}

function taskPermissionBlock(mode: PermissionMode, profileName = "default"): string {
  return [
    "  task:",
    '    "*": deny',
    ...workflowSubagents.map((agent) => `    "${profileAgentName(agent, profileName)}": ${mode}`),
  ].join("\n")
}

function profileRoutingBlock(profileName: string): string {
  const suffix = (base: string) => `\`${profileAgentName(base, profileName)}\``
  return [
    "## Profile routing",
    `- Discovery: ${suffix("workflow-discovery")}`,
    `- Architecture: ${suffix("workflow-architecture")}`,
    `- Frontend: ${suffix("workflow-frontend")}`,
    `- Backend: ${suffix("workflow-backend")}`,
    `- Security: ${suffix("workflow-security")}`,
    `- Reliability: ${suffix("workflow-reliability")}`,
    `- Reviewer: ${suffix("workflow-reviewer")}`,
    `- Consultant: ${suffix("workflow-consultant")}`,
  ].join("\n")
}

function applyProfileIdentity(content: string, baseAgent: string, profileName: string): string {
  if (profileName === "default") return content
  const generatedAgent = profileAgentName(baseAgent, profileName)
  let updated = content
  updated = updated.replace(/^description:\s*(.*)$/m, (_match, description) => `description: ${description} [perfil ${profileName}]`)
  updated = updated.replaceAll("workflow-lead", "workflow-lead-" + profileName)
  updated = updated.replaceAll("workflow-discovery", "workflow-discovery-" + profileName)
  updated = updated.replaceAll("workflow-architecture", "workflow-architecture-" + profileName)
  updated = updated.replaceAll("workflow-frontend", "workflow-frontend-" + profileName)
  updated = updated.replaceAll("workflow-backend", "workflow-backend-" + profileName)
  updated = updated.replaceAll("workflow-security", "workflow-security-" + profileName)
  updated = updated.replaceAll("workflow-reliability", "workflow-reliability-" + profileName)
  updated = updated.replaceAll("workflow-reviewer", "workflow-reviewer-" + profileName)
  updated = updated.replaceAll("workflow-consultant", "workflow-consultant-" + profileName)
  updated = updated.replaceAll("__WORKFLOW_PROFILE_AGENT__", generatedAgent)
  return updated
}

async function syncLeadPermissions(filePath: string, permissions: WorkflowPermissions, profileName: string): Promise<void> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    console.error(`warning: agent file not found, skipped: ${filePath}`)
    return
  }
  let current = await file.text()
  current = current.replace(/^  question:\s*.*$/m, `  question: ${permissions.question}`)
  current = current.replace(/^  edit:\s*.*$/m, `  edit: ${permissions.edit}`)
  current = markedBlock(current, "workflow-permissions-bash-start", "workflow-permissions-bash-end", bashPermissionBlock(permissions.bash, permissions.git_push))
  current = markedBlock(current, "workflow-permissions-task-start", "workflow-permissions-task-end", taskPermissionBlock(permissions.task, profileName))
  current = markedBlock(current, "workflow-permissions-external-start", "workflow-permissions-external-end", [
    "  external_directory:",
    `    \"*\": ${permissions.external_directory}`,
    `    "${workflowStateDirectory}/*": allow`,
  ].join("\n"))
  if (current !== await file.text()) await Bun.write(filePath, current)
}

async function syncAgentPermissions(config: WorkflowConfig): Promise<void> {
  await syncLeadPermissions(`${agentRoot}/workflow-lead.md`, defaultProfile(config).permissions, "default")
  for (const profile of Object.keys(config.profiles)) {
    const profileName = profile
    for (const base of profileAgentBases) {
      const targetPath = `${agentRoot}/${profileAgentName(base, profileName)}.md`
      if (!(await Bun.file(targetPath).exists())) continue
      let content = applyProfileIdentity(await Bun.file(targetPath).text(), base, profileName)
      if (base === "workflow-lead") {
        const routingStart = "<!-- workflow-profile-routing-start -->"
        const routingEnd = "<!-- workflow-profile-routing-end -->"
        const routingPattern = new RegExp(`${routingStart}[\\s\\S]*?${routingEnd}`)
        if (routingPattern.test(content)) content = content.replace(routingPattern, `${routingStart}\n${profileRoutingBlock(profileName)}\n${routingEnd}`)
      }
      await Bun.write(targetPath, content)
    }
    const targetPath = `${agentRoot}/${profileAgentName("workflow-lead", profileName)}.md`
    if (!(await Bun.file(targetPath).exists())) continue
    await syncLeadPermissions(targetPath, profileConfig(config, profileName).permissions, profileName)
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

type TuiMode = "main" | "model" | "variant" | "manual-model" | "manual-variant" | "policies" | "permissions" | "review"
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
  permissionCursor: number
  permissionEditing: boolean
  permissionChoice: number
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

const tuiPermissionItems = [
  { key: "edit", label: "Edición de archivos", description: "Permite que el Lead escriba, modifique y aplique parches.", choices: ["allow", "ask", "deny"] as const },
  { key: "bash", label: "Comandos shell", description: "Controla los comandos Bash; reset destructivo, rm -rf y sudo permanecen bloqueados.", choices: ["allow", "ask", "deny"] as const },
  { key: "git_push", label: "Git push", description: "Permite proponer un push y pedir aprobación antes de ejecutarlo.", choices: ["ask", "deny"] as const },
  { key: "task", label: "Subagentes", description: "Controla el lanzamiento de los consultores workflow-* permitidos.", choices: ["allow", "ask", "deny"] as const },
  { key: "external_directory", label: "Fuera del proyecto", description: "Permite acceder a rutas externas; el directorio de estado del workflow siempre se conserva.", choices: ["allow", "ask", "deny"] as const },
  { key: "question", label: "Preguntas interactivas", description: "Permite que el Lead pause y solicite una decisión con opciones.", choices: ["allow", "deny"] as const },
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

function tuiCurrentPermission(state: TuiState): string {
  const item = tuiPermissionItems[state.permissionCursor]
  return state.config.permissions[item.key as keyof WorkflowPermissions]
}

function tuiSetPermission(state: TuiState, value: string): void {
  const item = tuiPermissionItems[state.permissionCursor]
  state.config.permissions[item.key as keyof WorkflowPermissions] = value as never
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
  const assignmentCount = tuiAssignments().length
  const policyIndex = assignmentCount
  const permissionIndex = assignmentCount + 1
  const reviewIndex = assignmentCount + 2
  const labels = [...tuiAssignments().map((assignment) => assignment.label), "Políticas", "Permisos", "Revisar y guardar"]
  for (let index = 0; index < labels.length; index += 1) {
    const active = state.mode === "policies" ? index === policyIndex : state.mode === "permissions" ? index === permissionIndex : state.mode === "review" ? index === reviewIndex : state.selected === index
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

function tuiPermissionDetails(state: TuiState, width: number): string[] {
  const lines = [tuiBold("Permisos automáticos del Lead"), "", tuiDim("Estos valores solo se aplican a workflow-lead."), ""]
  tuiPermissionItems.forEach((item, index) => {
    const current = tuiCurrentPermission({ ...state, permissionCursor: index })
    const active = index === state.permissionCursor
    lines.push(active ? tuiBlue(`  ▸ ${item.label}: ${current}`) : `    ${item.label}: ${current}`)
    if (active) lines.push(...tuiWrap(item.description, width - 2).map((line) => `      ${tuiDim(line)}`))
    if (active && state.permissionEditing) {
      for (const [choiceIndex, choice] of item.choices.entries()) lines.push(choiceIndex === state.permissionChoice ? `      ${tuiCyan("●")} ${choice}` : `      ○ ${choice}`)
    }
  })
  lines.push("", tuiDim(state.permissionEditing ? "↑↓ elegir · Enter confirmar · Esc cancelar" : "↑↓ mover · Enter editar · Esc volver"))
  return lines
}

function tuiReviewDetails(state: TuiState, width: number): string[] {
  const lines = [tuiBold("Revisar configuración"), "", tuiDim("Nada se guarda hasta confirmar aquí."), ""]
  for (const assignment of tuiAssignments()) {
    const model = modelValue(state.config, assignment.path)
    const variant = variantValue(state.config, assignment.variantPath)
    lines.push(`${tuiCyan(assignment.label.padEnd(13))} ${model}  ·  ${variant}`)
  }
  lines.push(
    "",
    `${tuiCyan("Revisión")}      ${state.config.review_policy}`,
    `${tuiCyan("Consultores")}   ${state.config.consultation_policy}`,
    `${tuiCyan("Edición")}      ${state.config.permissions.edit}`,
    `${tuiCyan("Shell")}        ${state.config.permissions.bash}`,
    `${tuiCyan("Git push")}    ${state.config.permissions.git_push}`,
    `${tuiCyan("Subagentes")}   ${state.config.permissions.task}`,
    `${tuiCyan("Externos")}     ${state.config.permissions.external_directory}`,
    `${tuiCyan("Preguntas")}    ${state.config.permissions.question}`,
    "",
    tuiGreen("Enter guardar"), tuiDim("Esc volver · q cancelar"),
  )
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
            : state.mode === "permissions"
              ? tuiPermissionDetails(state, rightWidth)
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
    const sectionCount = tuiAssignments().length + 3
    if (key === "up") state.selected = (state.selected + sectionCount - 1) % sectionCount
    else if (key === "down" || key === "tab") state.selected = (state.selected + 1) % sectionCount
    else if (key === "escape") return "cancel"
    else if (key === "enter") {
      if (state.selected < tuiAssignments().length) tuiStartEditing(state)
      else if (state.selected === tuiAssignments().length) { state.mode = "policies"; state.policyCursor = 0 }
      else if (state.selected === tuiAssignments().length + 1) { state.mode = "permissions"; state.permissionCursor = 0 }
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
  if (state.mode === "permissions") {
    const item = tuiPermissionItems[state.permissionCursor]
    if (state.permissionEditing) {
      if (key === "up" || key === "left") state.permissionChoice = (state.permissionChoice + item.choices.length - 1) % item.choices.length
      else if (key === "down" || key === "right") state.permissionChoice = (state.permissionChoice + 1) % item.choices.length
      else if (key === "enter") { tuiSetPermission(state, item.choices[state.permissionChoice]); state.permissionEditing = false; state.status = `${item.label} actualizado.` }
      else if (key === "escape") state.permissionEditing = false
    } else if (key === "up") state.permissionCursor = (state.permissionCursor + tuiPermissionItems.length - 1) % tuiPermissionItems.length
    else if (key === "down") state.permissionCursor = (state.permissionCursor + 1) % tuiPermissionItems.length
    else if (key === "enter") { state.permissionChoice = item.choices.indexOf(tuiCurrentPermission(state) as never); state.permissionEditing = true }
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
    permissionCursor: 0, permissionEditing: false, permissionChoice: 0,
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

function profileForTui(profile: WorkflowProfile): WorkflowConfig {
  return { schema: defaults.schema, profiles: {}, ...profile }
}

function profileSnapshot(profile: WorkflowProfile, description: string): WorkflowProfileOverrides {
  return {
    description,
    lead_model: profile.lead_model,
    lead_variant: profile.lead_variant,
    areas: { ...profile.areas },
    area_variants: { ...profile.area_variants },
    reviewer_model: profile.reviewer_model,
    reviewer_variant: profile.reviewer_variant,
    review_policy: profile.review_policy,
    consultation_policy: profile.consultation_policy,
    engram_url: profile.engram_url,
    permissions: { ...profile.permissions },
  }
}

function applyConfiguredProfile(root: WorkflowConfig, profileName: string, edited: WorkflowConfig): WorkflowConfig {
  if (profileName === "default") {
    return mergeConfig({ ...root, ...defaultProfile(edited), profiles: root.profiles })
  }
  const existing = root.profiles[profileName]
  const description = typeof existing?.description === "string" && existing.description.trim()
    ? existing.description
    : `Perfil ${profileName}`
  return { ...root, profiles: { ...root.profiles, [profileName]: profileSnapshot(defaultProfile(edited), description) } }
}

async function configure(profileName = "default"): Promise<void> {
  if (profileName !== "default" && !validProfileName(profileName)) throw new Error(`Nombre de perfil inválido: ${profileName}`)
  const existing = await loadConfig()
  const rootConfig = mergeConfig(existing ?? undefined)
  const config = profileForTui(profileConfig(rootConfig, profileName))
  console.log("Preparando el catálogo de modelos…")
  const currentModels = modelAssignments.map((assignment) => modelValue(config, assignment.path))
  const models = await discoverModelCatalog(currentModels)
  const configured = await runConfigureTui(config, models)
  if (!configured) {
    console.log("Configuración cancelada. No se guardaron cambios.")
    return
  }
  const finalConfig = applyConfiguredProfile(rootConfig, profileName, configured)
  Bun.spawnSync(["mkdir", "-p", `${opencodeRoot}/continuous-workflow`])
  await saveConfig(finalConfig)
  await syncAgentModels(finalConfig)
  await syncAgentPermissions(finalConfig)
  console.log(`\nConfiguración guardada en ${configPath}`)
  console.log(`Perfil ${profileName} guardado; modelos, permisos y agentes sincronizados.`)
}

async function showConfig(): Promise<void> {
  const config = (await loadConfig()) ?? defaults
  console.log(JSON.stringify(config, null, 2))
}

async function profileCommand(action: string, name?: string): Promise<void> {
  const config = mergeConfig((await loadConfig()) ?? undefined)
  if (!action || action === "list") {
    const names = ["default", ...Object.keys(config.profiles).sort()]
    for (const profileName of names) {
      const profile = profileConfig(config, profileName)
      console.log(`${profileName}\t${profile.lead_model} [${profile.lead_variant}]\t${profile.description}`)
    }
    return
  }
  if (action === "create" || action === "add") {
    if (!name || !validProfileName(name)) throw new Error("profile create requiere un nombre (a-z, 0-9 y guiones; debe empezar por letra)")
    if (config.profiles[name]) throw new Error(`El perfil ${name} ya existe`)
    const base = defaultProfile(config)
    config.profiles[name] = profileSnapshot(base, `Perfil ${name}; copia independiente del perfil default.`)
    await saveConfig(config)
    await syncAgentModels(config)
    await syncAgentPermissions(config)
    console.log(`Perfil ${name} creado.`)
    console.log(`Ahora configura sus modelos y niveles con: workflow-ai configure --profile ${name}`)
    return
  }
  if (action === "remove" || action === "delete") {
    if (!name || !validProfileName(name)) throw new Error("profile remove requiere el nombre de un perfil no-default")
    if (!config.profiles[name]) throw new Error(`El perfil ${name} no existe`)
    delete config.profiles[name]
    await saveConfig(config)
    for (const base of profileAgentBases) await rm(`${agentRoot}/${profileAgentName(base, name)}.md`, { force: true })
    console.log(`Perfil ${name} eliminado junto con sus agentes generados.`)
    return
  }
  throw new Error("profile requiere list, create o remove")
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
  const missingProfiles: string[] = []
  for (const profile of Object.keys(config.profiles)) {
    for (const base of profileAgentBases) {
      const generated = profileAgentName(base, profile)
      if (!(await Bun.file(`${agentRoot}/${generated}.md`).exists())) missingProfiles.push(generated)
    }
  }
  const opencodeConfigPath = `${opencodeRoot}/opencode.json`
  let mcpConfig: Record<string, unknown> = {}
  try {
    const parsed = await Bun.file(opencodeConfigPath).json()
    mcpConfig = parsed?.mcp && typeof parsed.mcp === "object" ? parsed.mcp as Record<string, unknown> : {}
  } catch {}
  const mcpMissing = ["engram", "context7", "codegraph"].filter((name) => !mcpConfig[name])
  let healthy = missing.length === 0 && missingProfiles.length === 0 && mcpMissing.length === 0 && Boolean(Bun.which("opencode")) && Boolean(Bun.which("engram")) && Boolean(Bun.which("codegraph"))
  console.log(`workflow-ai config: ${configPath} ${await Bun.file(configPath).exists() ? "present" : "not created (defaults active)"}`)
  console.log(`opencode: ${Bun.which("opencode") ? "available" : "MISSING"}`)
  console.log(`engram: ${Bun.which("engram") ? "available" : "MISSING"}`)
  console.log(`codegraph: ${Bun.which("codegraph") ? "available" : "MISSING"}`)
  console.log(`workflow agents: ${missing.length ? `missing ${missing.join(", ")}` : "all present"}`)
  console.log(`profile agents: ${missingProfiles.length ? `missing ${missingProfiles.join(", ")}` : Object.keys(config.profiles).length ? `all present (${Object.keys(config.profiles).join(", ")})` : "none configured"}`)
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
  console.log(`workflow-ai — selectable Continuous Workflow\n\nCommands:\n  configure              Configure default models, policies, and permissions\n  configure --profile X  Configure an independent profile in the TUI\n  profile list           List default and independent profiles\n  profile create X       Clone the default profile into X\n  profile remove X       Remove X and only its generated agents\n  deps install           Install missing Engram, CodeGraph, and MCP registrations\n  deps update            Update pinned Engram and CodeGraph versions\n  deps status            Show dependency versions and Context7 registration\n  show                   Show the effective configuration\n  start [--profile X]    Start an interactive workflow Lead session\n  run [--profile X]      Run a non-interactive workflow Lead request\n  status <change-id>     Read persisted workflow status\n  resume <change-id>     Recover/continue a persisted workflow\n  complete <change-id>   Explicitly confirm and close a ready workflow\n  sync                   Reapply configured models to all workflow profiles\n  doctor                 Check installation and compatibility\n\nExamples:\n  workflow-ai configure\n  workflow-ai profile create deepseek\n  workflow-ai configure --profile deepseek\n  workflow-ai start --profile deepseek --dir /path/to/project\n  opencode --agent workflow-lead-deepseek\n  workflow-ai run --dir /path/to/project "implement feature X"\n  workflow-ai status feature-x\n  workflow-ai complete feature-x`)
}

function selectWorkflowAgent(args: string[]): { agent: string; args: string[] } {
  const remaining = [...args]
  const profileFlag = remaining.indexOf("--profile")
  if (profileFlag < 0) return { agent: "workflow-lead", args: remaining }
  const profile = remaining[profileFlag + 1]
  if (!profile || !validProfileName(profile)) throw new Error("--profile requiere el nombre de un perfil existente")
  remaining.splice(profileFlag, 2)
  return { agent: profileAgentName("workflow-lead", profile), args: remaining }
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2)
  if (command === "configure") {
    const profileFlag = args.indexOf("--profile")
    const profileName = profileFlag >= 0 ? args[profileFlag + 1] : "default"
    if (profileFlag >= 0 && (!profileName || args.length !== 2)) throw new Error("configure --profile requiere solo el nombre del perfil")
    return configure(profileName)
  }
  if (command === "profile" || command === "profiles") return profileCommand(args[0] ?? "list", args[1])
  if (command === "deps" || command === "dependencies") {
    const dependencyCommand = args[0] as "install" | "update" | "status" | undefined
    if (!dependencyCommand || !["install", "update", "status"].includes(dependencyCommand)) throw new Error("deps requiere install, update o status")
    return dependencies(dependencyCommand)
  }
  if (command === "show" || command === "config") return showConfig()
  if (command === "doctor") return doctor()
  if (command === "sync") {
    const config = (await loadConfig()) ?? defaults
    await saveConfig(config)
    await syncAgentModels(config)
    await syncAgentPermissions(config)
    console.log(`Synchronized workflow models and Lead permissions from ${configPath}`)
    return
  }
  if (command === "start") {
    const selected = selectWorkflowAgent(args)
    return runOpenCode(["--agent", selected.agent, ...selected.args])
  }
  if (command === "run") {
    const selected = selectWorkflowAgent(args)
    return runOpenCode(["run", "--agent", selected.agent, ...selected.args])
  }
  if (command === "status") {
    const change = args[0]
    if (!change) throw new Error("status requiere change-id")
    const selected = selectWorkflowAgent(args.slice(1))
    return runOpenCode(["run", "--agent", selected.agent, "--command", "work-status", change, ...selected.args])
  }
  if (command === "resume") {
    const change = args[0]
    if (!change) throw new Error("resume requiere change-id")
    const selected = selectWorkflowAgent(args.slice(1))
    return runOpenCode(["run", "--agent", selected.agent, "--command", "work-resume", change, ...selected.args])
  }
  if (command === "complete" || command === "close") {
    const change = args[0]
    if (!change) throw new Error("complete requiere change-id")
    const selected = selectWorkflowAgent(args.slice(1))
    return runOpenCode(["run", "--agent", selected.agent, "--command", "work-complete", change, ...selected.args])
  }
  usage()
}

main().catch((error) => {
  console.error(`workflow-ai: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
