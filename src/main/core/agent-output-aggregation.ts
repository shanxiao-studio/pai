import { appendMessageParts, markMessagePartsDone, splitAgentOutput, summarizeFinalMessageParts, summarizeMessageParts, type StoredMessagePart } from './chat-message-parts'
import type { AgentOutputEvent } from './models'

export type AssistantMessageAccumulator = {
  content: string
  thinking: string
  parts: StoredMessagePart[]
  stream?: 'stderr'
}

export function createAssistantMessageAccumulator(): AssistantMessageAccumulator {
  return {
    content: '',
    thinking: '',
    parts: [],
  }
}

export function appendAgentOutputEvent(
  state: AssistantMessageAccumulator,
  event: AgentOutputEvent,
): AssistantMessageAccumulator {
  const nextParts = Array.isArray(event.parts) && event.parts.length > 0
    ? event.parts
    : splitAgentOutput(event.text, event.stream).parts
  const parts = Array.isArray(event.parts) && event.parts.length > 0
    ? appendOnlyNewParts(state.parts, nextParts)
    : appendMessageParts(state.parts, nextParts)
  const summary = summarizeMessageParts(parts)

  return {
    content: summary.content || summary.plainText,
    thinking: summary.thinking,
    parts,
    stream: resolveStream(parts, event.stream ?? state.stream),
  }
}

export function hasAssistantMessageContent(state: AssistantMessageAccumulator) {
  return state.parts.length > 0 || state.content.trim().length > 0 || state.thinking.trim().length > 0
}

export function finalizeAssistantMessage(
  state: AssistantMessageAccumulator,
  fallbackError?: string,
): {
  content: string
  thinking?: string
  parts?: StoredMessagePart[]
  stream?: 'stderr'
} {
  const parts = state.parts.length > 0 ? markMessagePartsDone(state.parts) : []
  const summary = parts.length > 0
    ? summarizeFinalMessageParts(parts)
    : {
      content: state.content,
      thinking: state.thinking,
      plainText: state.content,
    }

  const content = (summary.content || summary.plainText || fallbackError || 'No output').trim()
  const thinking = summary.thinking.trim()

  return {
    content,
    thinking: thinking || undefined,
    parts: parts.length > 0 ? parts : undefined,
    stream: fallbackError ? 'stderr' : resolveStream(parts, state.stream),
  }
}

function appendOnlyNewParts(current: StoredMessagePart[], incoming: StoredMessagePart[]) {
  if (current.length === 0) return incoming
  if (incoming.length === 0) return current
  if (isPartPrefix(current, incoming)) return incoming

  const overlap = findPartOverlap(current, incoming)
  if (overlap >= incoming.length) return current
  return [...current, ...incoming.slice(overlap)]
}

function findPartOverlap(current: StoredMessagePart[], incoming: StoredMessagePart[]) {
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

function resolveStream(parts: StoredMessagePart[], stream?: 'stderr') {
  if (stream !== 'stderr') return undefined
  return parts.some((part) => part.type !== 'log') ? undefined : 'stderr'
}
