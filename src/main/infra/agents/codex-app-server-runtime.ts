import { ChildProcess, spawn } from 'child_process'
import { createInterface } from 'readline'
import { buildTranscriptOutput } from '../../core/agent-transcript'
import type { StoredMessagePart } from '../../core/chat-message-parts'
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
      hooks.onOutput?.({
        sessionId: runId,
        text: chunk.toString('utf8'),
        stream: 'stderr',
        threadId: session.threadId,
        turnId: session.turnId ?? undefined,
        source: 'codex-app-server',
        agentKind: 'codex',
      })
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
      this.emitStructuredOutput(params, [{ type: 'text', text: notification.delta }])
      return
    }

    if (method === 'reasoningText/delta' && typeof notification.delta === 'string') {
      this.emitStructuredOutput(params, [{ type: 'thinking', text: notification.delta, state: 'streaming' }])
      return
    }

    if (method === 'agentMessage' && isRecord(notification.message)) {
      const parts = readAppServerMessageParts(notification.message)
      if (parts.length > 0) {
        this.emitStructuredOutput(params, parts)
        return
      }
    }

    if (method === 'toolCall/started') {
      this.emitStructuredOutput(params, [{
        type: 'tool-call',
        id: stringValue(notification.id) ?? stringValue(notification.toolCallId),
        name: stringValue(notification.name) ?? stringValue(notification.toolName) ?? 'tool',
        args: notification.arguments ?? notification.input,
        state: 'running',
      }])
      return
    }

    if (method === 'toolCall/completed') {
      this.emitStructuredOutput(params, [{
        type: 'tool-result',
        id: stringValue(notification.id) ?? stringValue(notification.toolCallId),
        name: stringValue(notification.name) ?? stringValue(notification.toolName) ?? 'tool',
        result: notification.result ?? notification.output,
        text: typeof notification.outputText === 'string' ? notification.outputText : readLooseText(notification.result ?? notification.output),
        isError: notification.isError === true,
      }])
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

    if (method) {
      this.emitStructuredOutput(params, [{
        type: 'event',
        name: method,
        text: readLooseText(notification),
      }])
    }
  }

  private emitStructuredOutput(
    params: {
      sessionId: string
      session: RunningCodexSession
      pending: Map<number, PendingRequest>
      onOutput?: AgentRunHooks['onOutput']
      onDone: (event: AgentDoneEvent) => Promise<void>
    },
    parts: StoredMessagePart[],
  ) {
    if (parts.length === 0) return
    const output = buildTranscriptOutput(parts)
    params.onOutput?.({
      sessionId: params.sessionId,
      text: output.text,
      parts,
      threadId: params.session.threadId,
      turnId: params.session.turnId ?? undefined,
      source: 'codex-app-server',
      agentKind: 'codex',
    })
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

function readAppServerMessageParts(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : []
  const parts: StoredMessagePart[] = []

  for (const item of content) {
    if (!isRecord(item)) continue
    const type = stringValue(item.type)
    if ((type === 'text' || type === 'output_text') && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if ((type === 'reasoning' || type === 'reasoning_text') && typeof item.text === 'string') {
      parts.push({ type: 'thinking', text: item.text, state: 'streaming' })
      continue
    }
    if (type === 'tool_call' || type === 'function_call') {
      parts.push({
        type: 'tool-call',
        id: stringValue(item.id) ?? stringValue(item.call_id),
        name: stringValue(item.name) ?? 'tool',
        args: item.arguments ?? item.input,
        state: 'running',
      })
      continue
    }
    if (type === 'tool_result' || type === 'function_call_output') {
      parts.push({
        type: 'tool-result',
        id: stringValue(item.id) ?? stringValue(item.call_id),
        name: stringValue(item.name) ?? 'tool',
        result: item.output ?? item.result,
        text: typeof item.output_text === 'string' ? item.output_text : readLooseText(item.output ?? item.result),
        isError: item.is_error === true,
      })
    }
  }

  return parts
}

function readLooseText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => isRecord(item) && typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n') || undefined
  if (!isRecord(value)) return undefined
  if (typeof value.text === 'string') return value.text
  if (typeof value.message === 'string') return value.message
  if (typeof value.content === 'string') return value.content
  return undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
