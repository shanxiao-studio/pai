export type StoredMessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; state?: 'streaming' | 'done' }
  | { type: 'tool-call'; id?: string; name: string; args?: unknown; state?: 'running' | 'done' | 'error' }
  | { type: 'tool-result'; id?: string; name: string; result?: unknown; text?: string; isError?: boolean }
  | { type: 'event'; name: string; text?: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }

export function splitAgentOutput(text: string, stream?: string) {
  if (stream === 'stderr') {
    return { thinking: '', content: '', parts: [{ type: 'log' as const, stream: 'stderr' as const, text }] }
  }

  const parsed = parseStructuredAgentOutput(text)
  if (parsed) return parsed

  const thinkingLines: string[] = []
  const contentLines: string[] = []
  const parts: StoredMessagePart[] = []
  for (const line of text.split('\n')) {
    if (/^\s*(thinking|reasoning|analysis|思考)\s*[:：]/i.test(line)) {
      const thinkingText = line.replace(/^\s*(thinking|reasoning|analysis|思考)\s*[:：]\s*/i, '')
      thinkingLines.push(thinkingText)
      parts.push({ type: 'thinking', text: thinkingText, state: 'streaming' })
    } else {
      contentLines.push(line)
    }
  }

  const content = contentLines.join('\n')
  if (content) parts.push({ type: 'text', text: content })

  return {
    thinking: thinkingLines.length ? `${thinkingLines.join('\n')}\n` : '',
    content,
    parts,
  }
}

export function appendMessageParts(current: StoredMessagePart[], incoming: StoredMessagePart[]) {
  if (incoming.length === 0) return current
  return [...current, ...incoming]
}

export function markMessagePartsDone(parts: StoredMessagePart[]) {
  return parts.map((part) => {
    if (part.type === 'thinking') return { ...part, state: 'done' as const }
    if (part.type === 'tool-call' && part.state === 'running') return { ...part, state: 'done' as const }
    return part
  })
}

function parseStructuredAgentOutput(text: string) {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  let parsedAny = false
  let thinking = ''
  let content = ''
  const parts: StoredMessagePart[] = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      parsedAny = true
      const message = event?.message
      if (Array.isArray(message?.content)) {
        if (message.role === 'toolResult') {
          parts.push(readToolResultPart(message))
          continue
        }

        for (const item of message.content) {
          if (item?.type === 'thinking' && typeof item.thinking === 'string') {
            thinking += `${item.thinking}\n`
            parts.push({ type: 'thinking', text: item.thinking, state: 'streaming' })
          }
          if (item?.type === 'text' && typeof item.text === 'string') {
            content += item.text
            parts.push({ type: 'text', text: item.text })
          }
          const toolCall = readToolCallPart(item)
          if (toolCall) parts.push(toolCall)
          const toolResult = readInlineToolResultPart(item)
          if (toolResult) parts.push(toolResult)
        }
      } else if (typeof event?.text === 'string') {
        content += event.text
        parts.push({ type: 'text', text: event.text })
      } else if (event?.type && event.type !== 'message') {
        parts.push(readEventPart(event))
      }
    } catch {
      content += `${line}\n`
      parts.push({ type: 'text', text: `${line}\n` })
    }
  }

  return parsedAny ? { thinking, content, parts } : null
}

function readToolCallPart(item: unknown): StoredMessagePart | null {
  if (!isRecord(item)) return null
  const type = typeof item.type === 'string' ? item.type : ''
  if (!['toolCall', 'tool_call', 'function_call'].includes(type)) return null

  const fn = isRecord(item.function) ? item.function : undefined
  const name = stringValue(item.name) ?? stringValue(item.toolName) ?? stringValue(fn?.name) ?? 'tool'
  return {
    type: 'tool-call',
    id: stringValue(item.id) ?? stringValue(item.toolCallId),
    name,
    args: parseMaybeJson(item.arguments ?? item.args ?? item.input ?? fn?.arguments),
    state: 'running',
  }
}

function readInlineToolResultPart(item: unknown): StoredMessagePart | null {
  if (!isRecord(item)) return null
  const type = typeof item.type === 'string' ? item.type : ''
  if (!['toolResult', 'tool_result', 'function_result'].includes(type)) return null

  const result = item.result ?? item.output ?? item.content
  return {
    type: 'tool-result',
    id: stringValue(item.id) ?? stringValue(item.toolCallId),
    name: stringValue(item.name) ?? stringValue(item.toolName) ?? 'tool',
    result,
    text: resultToText(result),
    isError: item.isError === true,
  }
}

function readToolResultPart(message: Record<string, unknown>): StoredMessagePart {
  const result = message.content
  return {
    type: 'tool-result',
    id: stringValue(message.toolCallId),
    name: stringValue(message.toolName) ?? 'tool',
    result,
    text: resultToText(result),
    isError: message.isError === true,
  }
}

function readEventPart(event: Record<string, unknown>): StoredMessagePart {
  const name = stringValue(event.type) ?? 'event'
  const text = stringValue(event.content) ?? stringValue(event.message) ?? undefined
  return { type: 'event', name, text }
}

function resultToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : null)
      .filter((item): item is string => Boolean(item))
      .join('\n')
    return text || undefined
  }
  return undefined
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
