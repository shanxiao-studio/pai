import { execFile } from 'child_process'
import { AgentInfo } from '../../core/models'

type AgentDetector = {
  kind: string
  commands: string[]
  versionFlags: string[]
  modelListFlags: string[]
}

const AGENT_DETECTORS: AgentDetector[] = [
  { kind: 'codex', commands: ['codex'], versionFlags: ['--version'], modelListFlags: ['--list-models'] },
  { kind: 'pi', commands: ['pi'], versionFlags: ['--version', '-v'], modelListFlags: ['--list-models'] },
  { kind: 'claude', commands: ['claude', 'claudecode'], versionFlags: ['--version', '-v'], modelListFlags: [] },
]

const FALLBACK_MODELS: Record<string, string[]> = {
  codex: [],
  pi: [],
  claude: [],
}

export class AgentRegistry {
  private detectCache: { agents: AgentInfo[]; expiresAt: number } | null = null
  private detectInflight: Promise<AgentInfo[]> | null = null
  private modelListCache = new Map<string, { models: string[]; expiresAt: number }>()
  private modelListInflight = new Map<string, Promise<string[]>>()

  constructor(
    private readonly detectTtlMs = 5 * 60 * 1000,
    private readonly modelTtlMs = 5 * 60 * 1000,
  ) {}

  async detectAgents(): Promise<AgentInfo[]> {
    if (this.detectCache && this.detectCache.expiresAt > Date.now()) return this.detectCache.agents
    if (this.detectInflight) return this.detectInflight

    this.detectInflight = Promise.all(AGENT_DETECTORS.map((detector) => this.detectOne(detector)))
      .then((agents) => {
        this.detectCache = { agents, expiresAt: Date.now() + this.detectTtlMs }
        return agents
      })
      .finally(() => {
        this.detectInflight = null
      })

    return this.detectInflight
  }

  async listModels(agentKind: string): Promise<string[]> {
    const cached = this.modelListCache.get(agentKind)
    if (cached && cached.expiresAt > Date.now()) return cached.models

    const inflight = this.modelListInflight.get(agentKind)
    if (inflight) return inflight

    const request = this.listAgentModels(agentKind)
      .then((models) => {
        this.modelListCache.set(agentKind, { models, expiresAt: Date.now() + this.modelTtlMs })
        return models
      })
      .finally(() => {
        this.modelListInflight.delete(agentKind)
      })

    this.modelListInflight.set(agentKind, request)
    return request
  }

  async resolveCommand(agentKind: string): Promise<string> {
    const detector = AGENT_DETECTORS.find((item) => item.kind === agentKind)
    if (!detector) throw new Error(`Unknown agent: ${agentKind}`)

    for (const command of detector.commands) {
      try {
        await detectAgent(command, detector.versionFlags)
        return command
      } catch {
        // Try next command name.
      }
    }

    return detector.commands[0]!
  }

  private async detectOne(detector: AgentDetector): Promise<AgentInfo> {
    for (const command of detector.commands) {
      try {
        const version = await detectAgent(command, detector.versionFlags)
        if (version !== null) {
          return { kind: detector.kind, command, version, available: true }
        }
      } catch {
        // Try next command name.
      }
    }
    return { kind: detector.kind, command: detector.commands[0]!, version: null, available: false, error: `${detector.commands.join(' / ')} not found` }
  }

  private async listAgentModels(agentKind: string): Promise<string[]> {
    const detector = AGENT_DETECTORS.find((item) => item.kind === agentKind)
    if (!detector) return FALLBACK_MODELS[agentKind] ?? []

    let agentCommand = ''
    for (const command of detector.commands) {
      try {
        await detectAgent(command, detector.versionFlags)
        agentCommand = command
        break
      } catch {
        // Try next command name.
      }
    }
    if (!agentCommand) return FALLBACK_MODELS[agentKind] ?? []

    for (const flag of detector.modelListFlags) {
      try {
        const output = await new Promise<string>((resolve, reject) => {
          execFile(agentCommand, [flag], { timeout: 3000 }, (error, stdout, stderr) => {
            const text = (stdout + stderr).trim()
            if (text) return resolve(text)
            if (error) return reject(error)
            reject(new Error('no output'))
          })
        })
        const models = parseModelList(output, agentKind)
        if (models.length > 0) return models
      } catch {
        // Try next flag.
      }
    }

    return FALLBACK_MODELS[agentKind] ?? []
  }
}

async function detectAgent(command: string, versionFlags: string[]): Promise<string | null> {
  for (const flag of versionFlags) {
    try {
      const version = await new Promise<string | null>((resolve, reject) => {
        execFile(command, [flag], { timeout: 1500 }, (error, stdout, stderr) => {
          const output = (stdout + stderr).trim()
          if (output) return resolve(output.split('\n')[0] ?? null)
          if (error) return reject(error)
          resolve(null)
        })
      })
      if (version) return version
    } catch {
      // Try next flag.
    }
  }

  return null
}

function parseModelList(output: string, agentKind: string): string[] {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)

  if (agentKind === 'pi') {
    const models: string[] = []
    for (const line of lines) {
      if (line.startsWith('provider') || line.startsWith('---') || line.includes('────')) continue
      const columns = line.split(/\s{2,}/)
      if (columns.length >= 2) {
        const provider = columns[0]!
        const model = columns[1]!
        if (model.length > 1 && !model.includes(' ')) {
          models.push(`${provider}/${model}`)
        }
      }
    }
    return [...new Set(models)]
  }

  const modelPattern = /^[a-zA-Z][\w.-]*[a-zA-Z0-9]$/
  const models = lines
    .map((line) => {
      if (line.includes(' ') && !line.includes('-')) return null
      const firstWord = line.split(/\s+/)[0]!
      if (modelPattern.test(firstWord)) return firstWord
      return null
    })
    .filter((model): model is string => model !== null && model.length > 1)

  return [...new Set(models)].sort()
}
