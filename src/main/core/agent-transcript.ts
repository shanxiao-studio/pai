import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { JsonRecord } from './models'
import { markMessagePartsDone, summarizeMessageParts, type StoredMessagePart } from './chat-message-parts'

export type TranscriptSourceMeta = {
  agentKind?: string
  path?: string
  threadId?: string
  turnId?: string
  updatedAt?: string
}

type TranscriptFrame =
  | { kind: 'boundary'; timestamp?: string }
  | {
    kind: 'message'
    timestamp: string
    parts: StoredMessagePart[]
    stream?: 'stderr'
    source?: string
    threadId?: string
    turnId?: string
  }

type TranscriptMessageRecord = JsonRecord & {
  timestamp: string
  role: 'assistant'
  content: string
  thinking?: string
  parts?: StoredMessagePart[]
  stream?: 'stderr'
  threadId?: string
  turnId?: string
  agentKind?: string
  source?: string
}

export function buildTranscriptOutput(parts: StoredMessagePart[]) {
  const summary = summarizeMessageParts(parts)
  return {
    text: summary.content || summary.plainText,
    content: summary.content || summary.plainText,
    thinking: summary.thinking,
  }
}

export function readPiTranscriptFrames(record: JsonRecord): TranscriptFrame[] {
  if (record.type === 'message' && isRecord(record.message)) {
    const message = record.message
    const timestamp = stringValue(record.timestamp) ?? stringValue(message.timestamp) ?? new Date().toISOString()
    const role = stringValue(message.role)
    if (role === 'user') return [{ kind: 'boundary', timestamp }]
    if (role === 'assistant') {
      const parts = readMessageContent(message.content)
      return parts.length ? [{ kind: 'message', timestamp, parts, source: 'pi-transcript' }] : []
    }
    if (role === 'toolResult') {
      return [{
        kind: 'message',
        timestamp,
        parts: [readToolResultMessage(message)],
        source: 'pi-transcript',
      }]
    }
  }

  const type = stringValue(record.type)
  if (!type || ['session', 'model_change', 'thinking_level_change'].includes(type)) return []

  return [{
    kind: 'message',
    timestamp: stringValue(record.timestamp) ?? new Date().toISOString(),
    parts: [{ type: 'event', name: type, text: readLooseText(record) }],
    source: 'pi-transcript',
  }]
}

export function readClaudeTranscriptFrames(record: JsonRecord): TranscriptFrame[] {
  const type = stringValue(record.type)
  const timestamp = stringValue(record.timestamp) ?? new Date().toISOString()

  if (type === 'assistant' && isRecord(record.message)) {
    const message = record.message
    const parts = readClaudeAssistantContent(message.content)
    return parts.length ? [{ kind: 'message', timestamp, parts, source: 'claude-transcript' }] : []
  }

  if (type === 'user' && isRecord(record.message)) {
    const message = record.message
    const toolResultParts = readClaudeToolResultContent(message.content)
    if (toolResultParts.length > 0) {
      return [{ kind: 'message', timestamp, parts: toolResultParts, source: 'claude-transcript' }]
    }

    if (hasClaudeUserPrompt(message.content)) return [{ kind: 'boundary', timestamp }]
    return []
  }

  if (type === 'system') {
    const name = stringValue(record.subtype) ?? 'system'
    const text = stringValue(record.content) ?? readLooseText(record.message) ?? readLooseText(record.toolUseResult)
    return [{
      kind: 'message',
      timestamp,
      parts: [{ type: 'event', name, text }],
      source: 'claude-transcript',
    }]
  }

  return []
}

export function readCodexTranscriptFrames(record: JsonRecord): TranscriptFrame[] {
  const type = stringValue(record.type)
  const timestamp = stringValue(record.timestamp) ?? new Date().toISOString()

  if (type === 'response_item' && isRecord(record.payload)) {
    const payload = record.payload
    const payloadType = stringValue(payload.type)
    if (payloadType === 'message') {
      const role = stringValue(payload.role)
      if (role === 'user') return [{ kind: 'boundary', timestamp }]
      if (role === 'assistant') {
        const parts = readCodexResponseContent(payload.content)
        return parts.length ? [{ kind: 'message', timestamp, parts, source: 'codex-transcript' }] : []
      }
    }

    const toolParts = readCodexPayloadToolParts(payload)
    if (toolParts.length > 0) {
      return [{ kind: 'message', timestamp, parts: toolParts, source: 'codex-transcript' }]
    }
  }

  if (type === 'event_msg' && isRecord(record.payload)) {
    const payload = record.payload
    const payloadType = stringValue(payload.type)
    if (payloadType === 'user_message') return [{ kind: 'boundary', timestamp }]
    if (!payloadType) return []

    return [{
      kind: 'message',
      timestamp,
      parts: [{ type: 'event', name: payloadType, text: stringValue(payload.message) ?? readLooseText(payload) }],
      source: 'codex-transcript',
      turnId: stringValue(payload.turn_id),
    }]
  }

  return []
}

export function assembleTranscriptMessages(
  frames: TranscriptFrame[],
  defaults: { agentKind?: string; threadId?: string; turnId?: string; source?: string } = {},
): TranscriptMessageRecord[] {
  const messages: TranscriptMessageRecord[] = []
  let current: {
    timestamp: string
    parts: StoredMessagePart[]
    stream?: 'stderr'
    source?: string
    threadId?: string
    turnId?: string
  } | null = null

  const flush = () => {
    if (!current || current.parts.length === 0) return
    const parts = markMessagePartsDone(current.parts)
    const summary = summarizeMessageParts(parts)
    messages.push({
      timestamp: current.timestamp,
      role: 'assistant',
      content: summary.content || summary.plainText,
      thinking: summary.thinking || undefined,
      parts,
      stream: current.stream,
      threadId: current.threadId ?? defaults.threadId,
      turnId: current.turnId ?? defaults.turnId,
      agentKind: defaults.agentKind,
      source: current.source ?? defaults.source,
    })
    current = null
  }

  for (const frame of frames) {
    if (frame.kind === 'boundary') {
      flush()
      continue
    }

    if (!current) {
      current = {
        timestamp: frame.timestamp,
        parts: [],
        stream: frame.stream,
        source: frame.source,
        threadId: frame.threadId,
        turnId: frame.turnId,
      }
    }

    current.parts.push(...frame.parts)
    current.stream = current.stream ?? frame.stream
    current.source = current.source ?? frame.source
    current.threadId = current.threadId ?? frame.threadId
    current.turnId = current.turnId ?? frame.turnId
  }

  flush()
  return messages
}

export async function readPiTranscriptMessages(piRuntimeDir: string) {
  const files = await listJsonlFiles(piRuntimeDir)
  const frames: TranscriptFrame[] = []
  for (const filePath of files) {
    frames.push(...readJsonlFrames(filePath, readPiTranscriptFrames))
  }
  return assembleTranscriptMessages(frames, { agentKind: 'pi', source: 'pi-transcript' })
}

export async function readClaudeTranscriptMessages(filePath: string) {
  const frames = readJsonlFrames(filePath, readClaudeTranscriptFrames)
  return assembleTranscriptMessages(frames, { agentKind: 'claude', source: 'claude-transcript' })
}

export async function readCodexTranscriptMessages(filePath: string, meta: { threadId?: string; turnId?: string } = {}) {
  const frames = readJsonlFrames(filePath, readCodexTranscriptFrames)
  return assembleTranscriptMessages(frames, {
    agentKind: 'codex',
    source: 'codex-transcript',
    threadId: meta.threadId,
    turnId: meta.turnId,
  })
}

export function claudeProjectTranscriptDir(workspacePath: string) {
  return join(homedir(), '.claude', 'projects', workspacePath.replace(/[/\\]+/g, '-'))
}

export async function findLatestClaudeTranscriptPath(workspacePath: string) {
  return findLatestJsonlFile(claudeProjectTranscriptDir(workspacePath))
}

export async function findCodexTranscriptPath(threadId?: string) {
  const rootDir = join(homedir(), '.codex', 'sessions')
  if (!threadId) return findLatestJsonlFile(rootDir)

  const candidates = await listJsonlFilesRecursive(rootDir)
  for (const filePath of candidates) {
    if (basename(filePath).includes(threadId)) return filePath
    const raw = requireText(filePath)
    if (raw.includes(threadId)) return filePath
  }

  return null
}

function readJsonlFrames(filePath: string, readFrames: (record: JsonRecord) => TranscriptFrame[]) {
  const raw = requireText(filePath)
  if (!raw) return []
  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line)
        return isRecord(value) ? readFrames(value) : []
      } catch {
        return []
      }
    })
}

async function listJsonlFiles(dirPath: string) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(dirPath, entry.name))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

async function listJsonlFilesRecursive(rootDir: string) {
  const stack = [rootDir]
  const files: Array<{ path: string; mtimeMs: number }> = []

  while (stack.length > 0) {
    const currentDir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        const stat = await fs.stat(entryPath)
        files.push({ path: entryPath, mtimeMs: stat.mtimeMs })
      } catch {
        // Ignore removed files.
      }
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.path)
}

async function findLatestJsonlFile(rootDir: string, matcher?: (filePath: string) => boolean): Promise<string | null> {
  const stack = [rootDir]
  let latest: { path: string; mtimeMs: number } | null = null

  while (stack.length > 0) {
    const currentDir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (matcher && !matcher(entryPath)) continue

      try {
        const stat = await fs.stat(entryPath)
        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = { path: entryPath, mtimeMs: stat.mtimeMs }
        }
      } catch {
        // Ignore removed files.
      }
    }
  }

  return latest?.path ?? null
}

function requireText(filePath: string) {
  try {
    return require('fs').readFileSync(filePath, 'utf8') as string
  } catch {
    return ''
  }
}

function readClaudeAssistantContent(value: unknown) {
  const items = readArray(value)
  const parts: StoredMessagePart[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = stringValue(item.type)
    if (type === 'thinking' && typeof item.thinking === 'string') {
      parts.push({ type: 'thinking', text: item.thinking, state: 'streaming' })
      continue
    }
    if ((type === 'text' || type === 'output_text') && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if (type === 'tool_use') {
      parts.push({
        type: 'tool-call',
        id: stringValue(item.id),
        name: stringValue(item.name) ?? 'tool',
        args: item.input,
        state: 'running',
      })
    }
  }
  return parts
}

function readClaudeToolResultContent(value: unknown) {
  const items = readArray(value)
  const parts: StoredMessagePart[] = []
  for (const item of items) {
    if (!isRecord(item) || stringValue(item.type) !== 'tool_result') continue
    const text = typeof item.content === 'string'
      ? item.content
      : readTextContent(item.content)
    parts.push({
      type: 'tool-result',
      id: stringValue(item.tool_use_id),
      name: stringValue(item.name) ?? 'tool',
      result: item.content,
      text,
      isError: item.is_error === true,
    })
  }
  return parts
}

function hasClaudeUserPrompt(value: unknown) {
  if (typeof value === 'string') return value.trim().length > 0
  return readArray(value).some((item) => isRecord(item) && stringValue(item.type) === 'text' && typeof item.text === 'string')
}

function readCodexResponseContent(value: unknown) {
  const items = readArray(value)
  const parts: StoredMessagePart[] = []

  for (const item of items) {
    if (!isRecord(item)) continue
    const type = stringValue(item.type)
    if ((type === 'text' || type === 'output_text' || type === 'input_text') && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if ((type === 'reasoning' || type === 'reasoning_text') && typeof item.text === 'string') {
      parts.push({ type: 'thinking', text: item.text, state: 'streaming' })
      continue
    }
    if ((type === 'reasoning' || type === 'reasoning_text') && typeof item.summary === 'string') {
      parts.push({ type: 'thinking', text: item.summary, state: 'streaming' })
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

function readCodexPayloadToolParts(payload: JsonRecord) {
  const payloadType = stringValue(payload.type)
  if (payloadType === 'function_call' || payloadType === 'tool_call') {
    return [{
      type: 'tool-call' as const,
      id: stringValue(payload.id) ?? stringValue(payload.call_id),
      name: stringValue(payload.name) ?? 'tool',
      args: payload.arguments ?? payload.input,
      state: 'running' as const,
    }]
  }

  if (payloadType === 'function_call_output' || payloadType === 'tool_result') {
    return [{
      type: 'tool-result' as const,
      id: stringValue(payload.id) ?? stringValue(payload.call_id),
      name: stringValue(payload.name) ?? 'tool',
      result: payload.output ?? payload.result,
      text: typeof payload.output_text === 'string' ? payload.output_text : readLooseText(payload.output ?? payload.result),
      isError: payload.is_error === true,
    }]
  }

  return []
}

function readMessageContent(value: unknown) {
  const items = readArray(value)
  const parts: StoredMessagePart[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = stringValue(item.type)
    if (type === 'thinking' && typeof item.thinking === 'string') {
      parts.push({ type: 'thinking', text: item.thinking, state: 'streaming' })
      continue
    }
    if (type === 'text' && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if (type === 'toolCall') {
      parts.push({
        type: 'tool-call',
        id: stringValue(item.id),
        name: stringValue(item.name) ?? 'tool',
        args: item.arguments,
        state: 'running',
      })
    }
  }
  return parts
}

function readToolResultMessage(message: JsonRecord): StoredMessagePart {
  return {
    type: 'tool-result',
    id: stringValue(message.toolCallId),
    name: stringValue(message.toolName) ?? 'tool',
    result: message.content,
    text: readTextContent(message.content),
    isError: message.isError === true,
  }
}

function readTextContent(value: unknown) {
  if (typeof value === 'string') return value
  return readArray(value)
    .map((item) => isRecord(item) && typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
}

function readLooseText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return readTextContent(value) || undefined
  if (!isRecord(value)) return undefined
  return stringValue(value.text)
    ?? stringValue(value.message)
    ?? stringValue(value.content)
    ?? undefined
}

function readArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
