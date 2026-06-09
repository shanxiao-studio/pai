import { ChildProcess, spawn } from 'child_process'
import { createInterface } from 'readline'
import { AgentDoneEvent, AgentRunInput, AgentTokenUsage } from '../../core/models'
import { AgentRunHooks, AgentRuntime } from './agent-runtime'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type RunningCodexSession = {
  process: ChildProcess
  threadId: string
  turnId: string | null
  done: boolean
  tokenUsage: AgentTokenUsage | null
}

export class CodexAppServerRuntime implements AgentRuntime {
  private processes = new Map<string, RunningCodexSession>()

  isRunning(sessionId: string) {
    return this.processes.has(sessionId)
  }

  listRunning() {
    return Array.from(this.processes.keys())
  }

  cancel(sessionId: string) {
    const session = this.processes.get(sessionId)
    if (!session) return false
    if (session.turnId) {
      void this.sendRequest(session.process, 'turn/interrupt', {
        threadId: session.threadId,
        turnId: session.turnId,
      }).catch(() => {})
    }
    session.process.kill()
    this.processes.delete(sessionId)
    return true
  }

  async start(input: AgentRunInput, hooks: AgentRunHooks = {}) {
    const runId = input.sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (this.processes.has(runId)) throw new Error(`Agent session is already running: ${runId}`)

    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: input.workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: RunningCodexSession = {
      process: proc,
      threadId: runId,
      turnId: null,
      done: false,
      tokenUsage: null,
    }
    this.processes.set(runId, session)

    const pending = new Map<number, PendingRequest>()
    let nextId = 1
    const send = (method: string, params: Record<string, unknown>) => {
      const id = nextId++
      return this.sendRequest(proc, method, params, id, pending)
    }

    const finish = async (event: AgentDoneEvent) => {
      if (session.done) return
      session.done = true
      this.processes.delete(runId)
      await hooks.onDone?.({
        ...event,
        sessionId: runId,
        threadId: session.threadId,
        turnId: session.turnId ?? undefined,
        tokenUsage: session.tokenUsage ?? undefined,
      })
    }

    const output = createInterface({ input: proc.stdout! })
    output.on('line', (line) => {
      void this.handleMessage(line, {
        sessionId: runId,
        session,
        pending,
        onOutput: hooks.onOutput,
        onDone: finish,
      })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      hooks.onOutput?.({ sessionId: runId, text: chunk.toString('utf8'), stream: 'stderr', threadId: session.threadId, turnId: session.turnId ?? undefined })
    })

    proc.on('error', (error) => {
      void finish({ sessionId: runId, exitCode: -1, error: error.message })
    })
    proc.on('close', (code) => {
      void finish({ sessionId: runId, exitCode: code, error: code === 0 ? undefined : 'codex app-server exited unexpectedly' })
    })

    await send('initialize', {
      protocolVersion: 2,
      clientInfo: { name: 'pai', version: '0.1.0' },
      capabilities: {},
    })

    const threadResponse = await send('thread/start', {
      cwd: input.workspacePath,
      model: input.model || null,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }) as { thread?: { id?: string } }

    session.threadId = threadResponse.thread?.id || runId

    const turnResponse = await send('turn/start', {
      threadId: session.threadId,
      cwd: input.workspacePath,
      model: input.model || null,
      effort: normalizeCodexEffort(input.thinking),
      input: [{ type: 'input_text', text: input.message }],
    }) as { turn?: { id?: string } }

    session.turnId = turnResponse.turn?.id || null
    return { sessionId: runId }
  }

  private async handleMessage(line: string, params: {
    sessionId: string
    session: RunningCodexSession
    pending: Map<number, PendingRequest>
    onOutput?: AgentRunHooks['onOutput']
    onDone: (event: AgentDoneEvent) => Promise<void>
  }) {
    if (!line.trim()) return

    let message: Record<string, unknown>
    try {
      message = JSON.parse(line)
    } catch {
      params.onOutput?.({ sessionId: params.sessionId, text: `${line}\n`, threadId: params.session.threadId, turnId: params.session.turnId ?? undefined })
      return
    }

    if (typeof message.id === 'number') {
      const pending = params.pending.get(message.id)
      if (!pending) return
      params.pending.delete(message.id)
      if ('error' in message && message.error) {
        pending.reject(new Error(typeof message.error === 'object' && message.error && 'message' in message.error ? String((message.error as Record<string, unknown>).message) : 'app-server error'))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    const method = typeof message.method === 'string' ? message.method : ''
    const notification = isRecord(message.params) ? message.params : {}

    if (method === 'turn/started' && typeof notification.turnId === 'string') {
      params.session.turnId = notification.turnId
      return
    }

    if (method === 'agentMessage/delta' && typeof notification.delta === 'string') {
      params.onOutput?.({
        sessionId: params.sessionId,
        text: notification.delta,
        threadId: params.session.threadId,
        turnId: params.session.turnId ?? undefined,
      })
      return
    }

    if (method === 'reasoningText/delta' && typeof notification.delta === 'string') {
      params.onOutput?.({
        sessionId: params.sessionId,
        text: `thinking: ${notification.delta}`,
        threadId: params.session.threadId,
        turnId: params.session.turnId ?? undefined,
      })
      return
    }

    if (method === 'thread/tokenUsage/updated' && isRecord(notification.tokenUsage)) {
      params.session.tokenUsage = readTokenUsage(notification.tokenUsage)
      return
    }

    if (method === 'turn/completed') {
      await params.onDone({ sessionId: params.sessionId, exitCode: 0 })
      params.session.process.kill()
      return
    }
  }

  private sendRequest(
    proc: ChildProcess,
    method: string,
    params: Record<string, unknown>,
    id = 1,
    pendingStore = new Map<number, PendingRequest>(),
  ) {
    return new Promise<unknown>((resolve, reject) => {
      pendingStore.set(id, { resolve, reject })
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

function normalizeCodexEffort(value: string) {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return 'medium'
}

function readTokenUsage(value: Record<string, unknown>): AgentTokenUsage | null {
  const total = isRecord(value.total) ? value.total : null
  if (!total) return null
  return {
    inputTokens: readToken(total.inputTokens),
    outputTokens: readToken(total.outputTokens),
    reasoningOutputTokens: readToken(total.reasoningOutputTokens),
    cachedInputTokens: readToken(total.cachedInputTokens),
    totalTokens: readToken(total.totalTokens),
  }
}

function readToken(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
