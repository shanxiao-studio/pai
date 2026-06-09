import {
  appendMessageParts,
  markMessagePartsDone,
  normalizeStoredParts,
  splitAgentOutput,
  summarizeMessageParts,
  type ChatMessage,
  type MessagePart,
} from '@/components/chat/MessageSurface'

export type AgentOutputPayload = {
  sessionId: string
  text: string
  stream?: string
  threadId?: string
  turnId?: string
  parts?: unknown[]
  source?: string
  agentKind?: string
  path?: string
}

export type AgentLogRecord = {
  timestamp?: string
  role?: string
  type?: string
  content?: string
  thinking?: string
  parts?: unknown[]
  stream?: string
}

export type AssistantStreamState = {
  content: string
  thinking: string
  parts: MessagePart[]
  stream?: 'stderr'
}

export function createAssistantStreamState(): AssistantStreamState {
  return {
    content: '',
    thinking: '',
    parts: [],
  }
}

export function consumeAgentOutput(
  state: AssistantStreamState,
  output: AgentOutputPayload,
): AssistantStreamState {
  const structuredParts = normalizeStoredParts(output.parts)
  const nextParts = structuredParts?.length
    ? structuredParts
    : splitAgentOutput(output.text, output.stream).parts
  const parts = structuredParts?.length
    ? appendOnlyNewParts(state.parts, nextParts)
    : appendMessageParts(state.parts, nextParts)
  const summary = summarizeMessageParts(parts)

  return {
    content: summary.content || summary.plainText,
    thinking: summary.thinking,
    parts,
    stream: resolveStream(parts, output.stream === 'stderr' ? 'stderr' : state.stream),
  }
}

export function hasAssistantStreamContent(state: AssistantStreamState) {
  return state.parts.length > 0 || state.content.trim().length > 0 || state.thinking.trim().length > 0
}

export function finalizeAssistantStream(
  state: AssistantStreamState,
  fallbackError?: string,
): ChatMessage {
  const parts = state.parts.length > 0 ? markMessagePartsDone(state.parts) : undefined
  const summary = summarizeMessageParts(parts ?? [])
  const content = (summary.content || summary.plainText || fallbackError || 'No output').trim()
  const thinking = summary.thinking.trim()

  return {
    id: String(Date.now()),
    role: 'assistant',
    content,
    thinking: thinking || undefined,
    parts,
    stream: fallbackError ? 'stderr' : resolveStream(parts ?? [], state.stream),
  }
}

export function hasEquivalentMessage(messages: ChatMessage[], candidate: ChatMessage) {
  const serializedCandidateParts = JSON.stringify(candidate.parts ?? [])

  return messages.some((message) => (
    message.role === candidate.role &&
    message.content === candidate.content &&
    (message.thinking ?? '') === (candidate.thinking ?? '') &&
    (message.stream ?? '') === (candidate.stream ?? '') &&
    JSON.stringify(message.parts ?? []) === serializedCandidateParts
  ))
}

export function countRenderableAssistantMessages(messages: ChatMessage[]) {
  return messages.filter((message) => (
    message.role === 'assistant' &&
    (
      message.content.trim().length > 0 ||
      (message.thinking?.trim().length ?? 0) > 0 ||
      (message.parts?.length ?? 0) > 0
    )
  )).length
}

export function normalizeLogMessage(entry: AgentLogRecord): ChatMessage {
  return {
    id: entry.timestamp ?? String(Date.now()),
    role: entry.role === 'user' || entry.type === 'user' ? 'user' : 'assistant',
    content: entry.content ?? '',
    thinking: typeof entry.thinking === 'string' ? entry.thinking : undefined,
    parts: normalizeStoredParts(entry.parts),
    stream: entry.stream === 'stderr' ? 'stderr' : undefined,
  }
}

export function normalizeLogMessages(entries: AgentLogRecord[]) {
  return entries.map(normalizeLogMessage)
}

function appendOnlyNewParts(current: MessagePart[], incoming: MessagePart[]) {
  if (current.length === 0) return incoming
  if (incoming.length === 0) return current
  if (isPartPrefix(current, incoming)) return incoming

  const overlap = findPartOverlap(current, incoming)
  if (overlap >= incoming.length) return current
  return [...current, ...incoming.slice(overlap)]
}

function findPartOverlap(current: MessagePart[], incoming: MessagePart[]) {
  const max = Math.min(current.length, incoming.length)
  for (let size = max; size > 0; size -= 1) {
    const currentStart = current.length - size
    let matched = true
    for (let index = 0; index < size; index += 1) {
      if (!isSamePart(current[currentStart + index], incoming[index])) {
        matched = false
        break
      }
    }
    if (matched) return size
  }
  return 0
}

function isPartPrefix(prefix: MessagePart[], parts: MessagePart[]) {
  if (prefix.length > parts.length) return false
  return prefix.every((part, index) => isSamePart(part, parts[index]))
}

function isSamePart(left: MessagePart | undefined, right: MessagePart | undefined) {
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

function resolveStream(parts: MessagePart[], stream?: 'stderr') {
  if (stream !== 'stderr') return undefined
  return parts.some((part) => part.type !== 'log') ? undefined : 'stderr'
}
