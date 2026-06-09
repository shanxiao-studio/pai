import { ChildProcess, spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { AgentDoneEvent, AgentOutputEvent, AgentRunInput } from '../../core/models'
import { sessionDir } from '../fs/pai-paths'
import { AgentRegistry } from './agent-registry'
import { AgentRunHooks, AgentRuntime } from './agent-runtime'

export class AgentProcessRuntime implements AgentRuntime {
  private processes = new Map<string, ChildProcess>()

  constructor(private readonly registry: AgentRegistry) {}

  isRunning(sessionId: string) {
    return this.processes.has(sessionId)
  }

  listRunning() {
    return Array.from(this.processes.keys())
  }

  cancel(sessionId: string) {
    const proc = this.processes.get(sessionId)
    if (!proc) return false
    proc.kill()
    this.processes.delete(sessionId)
    return true
  }

  async start(input: AgentRunInput, hooks: AgentRunHooks = {}) {
    const runId = input.sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (this.processes.has(runId)) throw new Error(`Agent session is already running: ${runId}`)

    const agentCommand = await this.registry.resolveCommand(input.agentKind)
    const args = await this.buildArgs({ ...input, runId })
    const proc = spawn(agentCommand, args, {
      cwd: input.workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin?.end()
    this.processes.set(runId, proc)

    let finished = false
    const finish = async (exitCode: number | null, error?: string) => {
      if (finished) return
      finished = true
      this.processes.delete(runId)
      const event = { sessionId: runId, exitCode, ...(error ? { error } : {}) }
      try {
        await hooks.onDone?.(event)
      } catch (hookError) {
        console.error(`[agent-runtime] done hook failed for ${runId}:`, hookError)
      }
    }

    proc.on('error', (error) => {
      const text = `Failed to start ${input.agentKind}: ${error.message}`
      hooks.onOutput?.({ sessionId: runId, text, stream: 'stderr' })
      void finish(-1, error.message)
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      hooks.onOutput?.({ sessionId: runId, text: chunk.toString('utf8') })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      hooks.onOutput?.({ sessionId: runId, text: chunk.toString('utf8'), stream: 'stderr' })
    })

    proc.on('close', (code) => {
      void finish(code)
    })

    return { sessionId: runId }
  }

  private async buildArgs(input: AgentRunInput & { runId: string }) {
    if (input.agentKind === 'codex') {
      const args = ['exec']
      if (input.model) args.push('-m', input.model)
      if (input.thinking && input.thinking !== 'off') args.push('-c', `thinking=${input.thinking}`)
      args.push(input.message)
      return args
    }

    if (input.agentKind === 'pi') {
      const piRuntimeDir = join(sessionDir(input.workspacePath, input.runId), 'pi-runtime')
      await fs.mkdir(piRuntimeDir, { recursive: true })
      const args = ['--print', '--session-dir', piRuntimeDir]
      if (await hasFiles(piRuntimeDir)) args.push('--continue')
      if (input.model && input.model !== 'default') args.push('--model', input.model)
      if (input.thinking && input.thinking !== 'off') args.push('--thinking', input.thinking)
      args.push(input.message)
      return args
    }

    return ['-p', input.message]
  }
}

async function hasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) return true
      if (entry.isDirectory() && await hasFiles(join(dir, entry.name))) return true
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  return false
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
