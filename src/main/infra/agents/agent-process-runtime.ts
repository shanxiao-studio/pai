import { ChildProcess, spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { buildTranscriptOutput, findLatestClaudeTranscriptPath, readClaudeTranscriptMessages, readPiTranscriptMessages } from '../../core/agent-transcript'
import { StoredMessagePart } from '../../core/chat-message-parts'
import { AgentDoneEvent, AgentOutputEvent, AgentRunInput } from '../../core/models'
import { sessionDir } from '../fs/pai-paths'
import { AgentRegistry } from './agent-registry'
import { AgentRunHooks, AgentRuntime } from './agent-runtime'

type TranscriptTail = {
  stop: () => Promise<void>
  hasOutput: () => boolean
  hasPath: () => string | undefined
}

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
    const runStartedAt = new Date().toISOString()
    const args = await this.buildArgs({ ...input, runId })
    const proc = spawn(agentCommand, args, {
      cwd: input.workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin?.end()
    this.processes.set(runId, proc)

    const hasStructuredReplay = input.agentKind === 'pi' || input.agentKind === 'claude'
    const transcriptTail = hasStructuredReplay
      ? this.startStructuredTranscriptTail(input, runId, runStartedAt, hooks)
      : null
    let stdoutBuffer = ''

    let finished = false
    const finish = async (exitCode: number | null, error?: string) => {
      if (finished) return
      finished = true
      this.processes.delete(runId)
      await transcriptTail?.stop()
      if (hasStructuredReplay && !transcriptTail?.hasOutput() && stdoutBuffer.trim().length > 0) {
        hooks.onOutput?.({ sessionId: runId, text: stdoutBuffer, agentKind: input.agentKind })
      }
      const event = { sessionId: runId, exitCode, ...(error ? { error } : {}) }
      try {
        await hooks.onDone?.(event)
      } catch (hookError) {
        console.error(`[agent-runtime] done hook failed for ${runId}:`, hookError)
      }
    }

    proc.on('error', (error) => {
      const text = `Failed to start ${input.agentKind}: ${error.message}`
      hooks.onOutput?.({ sessionId: runId, text, stream: 'stderr', agentKind: input.agentKind })
      void finish(-1, error.message)
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (hasStructuredReplay) {
        stdoutBuffer += chunk.toString('utf8')
        return
      }
      hooks.onOutput?.({ sessionId: runId, text: chunk.toString('utf8'), agentKind: input.agentKind })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (hasStructuredReplay && !transcriptTail?.hasOutput() && text.trim().length === 0) return
      hooks.onOutput?.({ sessionId: runId, text, stream: 'stderr', agentKind: input.agentKind })
    })

    proc.on('close', (code) => {
      void finish(code)
    })

    return { sessionId: runId }
  }

  private startStructuredTranscriptTail(
    input: AgentRunInput,
    runId: string,
    runStartedAt: string,
    hooks: AgentRunHooks,
  ): TranscriptTail {
    let stopped = false
    let flushing = Promise.resolve()
    let outputCount = 0
    let transcriptPath: string | undefined
    const emittedParts = new Map<string, StoredMessagePart[]>()

    const emitMessages = async () => {
      if (stopped) return

      if (input.agentKind === 'pi') {
        const piRuntimeDir = join(sessionDir(input.workspacePath, runId), 'pi-runtime')
        transcriptPath = piRuntimeDir
        const messages = (await readPiTranscriptMessages(piRuntimeDir))
          .filter((message) => message.timestamp >= runStartedAt)
        for (const message of messages) {
          if (!message.parts?.length) continue
          const key = message.timestamp
          const parts = unreadTranscriptParts(emittedParts.get(key) ?? [], message.parts)
          if (parts.length === 0) continue
          emittedParts.set(key, message.parts)
          const output = buildTranscriptOutput(parts)
          hooks.onOutput?.({
            sessionId: runId,
            text: output.text,
            parts,
            stream: message.stream,
            threadId: message.threadId,
            turnId: message.turnId,
            source: message.source,
            agentKind: input.agentKind,
            path: piRuntimeDir,
          })
          outputCount += 1
        }
        return
      }

      if (input.agentKind === 'claude') {
        const nextTranscriptPath = transcriptPath ?? await findLatestClaudeTranscriptPath(input.workspacePath)
        if (!nextTranscriptPath) return
        transcriptPath = nextTranscriptPath
        const messages = (await readClaudeTranscriptMessages(nextTranscriptPath))
          .filter((message) => message.timestamp >= runStartedAt)
        for (const message of messages) {
          if (!message.parts?.length) continue
          const key = message.timestamp
          const parts = unreadTranscriptParts(emittedParts.get(key) ?? [], message.parts)
          if (parts.length === 0) continue
          emittedParts.set(key, message.parts)
          const output = buildTranscriptOutput(parts)
          hooks.onOutput?.({
            sessionId: runId,
            text: output.text,
            parts,
            stream: message.stream,
            source: message.source,
            agentKind: input.agentKind,
            path: nextTranscriptPath,
          })
          outputCount += 1
        }
      }
    }

    const scheduleFlush = () => {
      flushing = flushing
        .then(() => emitMessages())
        .catch((error) => {
          console.error(`[agent-runtime] transcript replay failed for ${runId}:`, error)
        })
    }

    scheduleFlush()
    const timer = setInterval(scheduleFlush, 400)

    return {
      stop: async () => {
        clearInterval(timer)
        await flushing
        try {
          await emitMessages()
        } catch (error) {
          console.error(`[agent-runtime] transcript replay failed for ${runId}:`, error)
        } finally {
          stopped = true
        }
      },
      hasOutput: () => outputCount > 0,
      hasPath: () => transcriptPath,
    }
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

function unreadTranscriptParts(previous: StoredMessagePart[], current: StoredMessagePart[]) {
  if (previous.length === 0) return current
  if (isPartPrefix(previous, current)) return current.slice(previous.length)
  if (isPartPrefix(current, previous)) return []
  return current
}

function isPartPrefix(prefix: StoredMessagePart[], parts: StoredMessagePart[]) {
  if (prefix.length > parts.length) return false
  return prefix.every((part, index) => isSamePart(part, parts[index]))
}

function isSamePart(left: StoredMessagePart | undefined, right: StoredMessagePart | undefined) {
  if (!left || !right || left.type !== right.type) return false
  if (left.type === 'thinking' && right.type === 'thinking') return left.text === right.text
  if (left.type === 'text' && right.type === 'text') return left.text === right.text
  if (left.type === 'tool-call' && right.type === 'tool-call') return left.id === right.id && left.name === right.name
  if (left.type === 'tool-result' && right.type === 'tool-result') {
    return left.id === right.id && left.name === right.name && (left.text ?? '') === (right.text ?? '')
  }
  if (left.type === 'event' && right.type === 'event') return left.name === right.name && (left.text ?? '') === (right.text ?? '')
  if (left.type === 'log' && right.type === 'log') return left.stream === right.stream && left.text === right.text
  return false
}
