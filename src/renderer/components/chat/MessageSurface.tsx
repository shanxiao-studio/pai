import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { Activity, Brain, ChevronRight, Circle, FileJson, Terminal, Wrench } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const MARKDOWN_PLUGINS = [remarkGfm]

export interface ChatMessage {
  _streaming?: boolean
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  parts?: MessagePart[]
  stream?: 'stderr'
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; state?: 'streaming' | 'done' }
  | { type: 'tool-call'; id?: string; name: string; args?: unknown; state?: 'running' | 'done' | 'error' }
  | { type: 'tool-result'; id?: string; name: string; result?: unknown; text?: string; isError?: boolean }
  | { type: 'event'; name: string; text?: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }

export function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user'
  const isError = message.stream === 'stderr'
  const isStreaming = streaming || message._streaming === true
  const parts = getMessageParts(message, isStreaming)
  const textParts = isUser ? parts : parts.filter((part) => part.type === 'text')
  const processParts = isUser ? [] : parts.filter((part) => part.type !== 'text')

  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div className={cn(
        'content-enter rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm shadow-black/[0.025]',
        isUser ? 'border-primary/15 bg-primary text-primary-foreground' : isError ? 'border-destructive/35 bg-destructive/10 text-foreground' : 'bg-[hsl(var(--surface-raised))]',
        isUser ? 'max-w-[88%]' : 'w-full',
        isStreaming && 'border-dashed',
      )}>
        <div className="flex flex-col gap-3">
          {textParts.map((part, index) => (
            <MessagePartView key={`${part.type}-${index}`} part={part} isUser={isUser} />
          ))}
          {processParts.length > 0 && (
            <ProcessFrame count={processParts.length} open={isStreaming}>
              {processParts.map((part, index) => (
                <MessagePartView key={`${part.type}-${index}`} part={part} isUser={isUser} />
              ))}
            </ProcessFrame>
          )}
        </div>
        {isStreaming && <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-muted-foreground align-middle" />}
      </div>
    </div>
  )
}

export function markMessagePartsDone(parts: MessagePart[]) {
  return parts.map((part) => {
    if (part.type === 'thinking') return { ...part, state: 'done' as const }
    if (part.type === 'tool-call' && part.state === 'running') return { ...part, state: 'done' as const }
    return part
  })
}

export function appendMessageParts(current: MessagePart[], incoming: MessagePart[]) {
  if (incoming.length === 0) return current
  return [...current, ...incoming]
}

export function normalizeStoredParts(value: unknown): MessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.map(normalizeMessagePart).filter((part): part is MessagePart => Boolean(part))
  return parts.length ? parts : undefined
}

export function summarizeMessageParts(parts: MessagePart[]) {
  let thinking = ''
  let content = ''
  const visibleLines: string[] = []

  for (const part of parts) {
    if (part.type === 'thinking') {
      thinking += part.text.endsWith('\n') ? part.text : `${part.text}\n`
      continue
    }

    if (part.type === 'text') {
      content += part.text
      visibleLines.push(part.text)
      continue
    }

    if (part.type === 'tool-result' && part.text) {
      visibleLines.push(part.text)
      continue
    }

    if (part.type === 'event' && part.text) {
      visibleLines.push(part.text)
      continue
    }

    if (part.type === 'log') {
      visibleLines.push(part.text)
    }
  }

  return {
    thinking,
    content,
    plainText: content || visibleLines.join('\n'),
  }
}

export function summarizeFinalMessageParts(parts: MessagePart[]) {
  const summary = summarizeMessageParts(parts)
  const finalText = [...parts].reverse().find((part) => part.type === 'text' && part.text.trim().length > 0)
  return {
    ...summary,
    content: finalText?.text ?? summary.content,
    plainText: finalText?.text ?? summary.plainText,
  }
}

export function splitAgentOutput(text: string, stream?: string) {
  if (stream === 'stderr') {
    return { thinking: '', content: '', parts: [{ type: 'log' as const, stream: 'stderr' as const, text }] }
  }

  const parsed = parseStructuredAgentOutput(text)
  if (parsed) return parsed

  const thinkingLines: string[] = []
  const contentLines: string[] = []
  const parts: MessagePart[] = []
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

function MessagePartView({ part, isUser }: { part: MessagePart; isUser: boolean }) {
  if (part.type === 'text') {
    return <MarkdownText text={part.text} isUser={isUser} />
  }

  if (part.type === 'thinking') {
    return (
      <details className={cn('group rounded-md border px-3 py-2 text-xs', isUser ? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/85' : 'bg-muted/35 text-muted-foreground')}>
        <summary className={cn('flex cursor-pointer select-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden', isUser ? 'text-primary-foreground/85' : 'text-foreground/75')}>
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <Brain className="size-3" />
          Thinking
        </summary>
        <pre className="mt-2 whitespace-pre-wrap font-sans leading-5">{part.text}</pre>
      </details>
    )
  }

  if (part.type === 'tool-call') {
    return (
      <ToolFrame icon={<Wrench className="size-3" />} title={part.name} meta={part.state === 'running' ? 'running' : part.state}>
        {part.args !== undefined && <JsonBlock value={part.args} />}
      </ToolFrame>
    )
  }

  if (part.type === 'tool-result') {
    return (
      <ToolFrame icon={<FileJson className="size-3" />} title={part.name} meta={part.isError ? 'error' : 'result'} tone={part.isError ? 'error' : 'default'}>
        {part.text ? <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre> : <JsonBlock value={part.result} />}
      </ToolFrame>
    )
  }

  if (part.type === 'log') {
    return (
      <ToolFrame icon={<Terminal className="size-3" />} title={part.stream} tone={part.stream === 'stderr' ? 'error' : 'default'}>
        <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre>
      </ToolFrame>
    )
  }

  return (
    <ToolFrame icon={<Circle className="size-3" />} title={part.name}>
      {part.text && <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre>}
    </ToolFrame>
  )
}

function MarkdownText({ text, isUser }: { text: string; isUser: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_PLUGINS}
      skipHtml
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        a: ({ children, href }) => (
          <a
            href={href}
            className={cn('font-medium underline underline-offset-4', isUser ? 'text-primary-foreground' : 'text-primary')}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="my-1 pl-1">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className={cn('my-3 border-l-2 pl-3 italic', isUser ? 'border-primary-foreground/35' : 'border-border text-muted-foreground')}>
            {children}
          </blockquote>
        ),
        h1: ({ children }) => <h1 className="mb-3 mt-1 text-lg font-semibold leading-7">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold leading-6">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold leading-6">{children}</h3>,
        hr: () => <div className={cn('my-4 border-t', isUser ? 'border-primary-foreground/25' : 'border-border')} />,
        table: ({ children }) => (
          <div className="my-3 max-w-full overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border-b bg-muted/45 px-2 py-1.5 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-b px-2 py-1.5 align-top last:border-b-0">{children}</td>,
        code: ({ children, className }) => (
          <code className={cn(className ? 'font-mono text-[12px]' : 'rounded bg-muted/70 px-1 py-0.5 font-mono text-[12px]', isUser && !className && 'bg-primary-foreground/15')}>
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className={cn('my-3 max-w-full overflow-x-auto rounded-md p-3 font-mono text-xs leading-5', isUser ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted/60 text-foreground')}>
            {children}
          </pre>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function ToolFrame({
  children,
  icon,
  title,
  meta,
  tone = 'default',
  open,
}: {
  children?: ReactNode
  icon: ReactNode
  title: string
  meta?: string
  tone?: 'default' | 'error'
  open?: boolean
}) {
  return (
    <details className={cn('group rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground', tone === 'error' && 'border-destructive/35 bg-destructive/10 text-foreground')} open={open}>
      <summary className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-medium text-foreground/75 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {icon}
        <span className="truncate">{title}</span>
        {meta && <span className="ml-auto shrink-0 rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{meta}</span>}
      </summary>
      {children && <div className="mt-2">{children}</div>}
    </details>
  )
}

function ProcessFrame({ children, count, open }: { children: ReactNode; count: number; open?: boolean }) {
  return (
    <details className="group rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground" open={open}>
      <summary className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-medium text-foreground/75 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <Activity className="size-3" />
        <span className="truncate">Process</span>
        <span className="ml-auto shrink-0 rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{count}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {children}
      </div>
    </details>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 font-mono text-[11px] leading-5 text-foreground/80">
      {formatJsonValue(value)}
    </pre>
  )
}

function getMessageParts(message: ChatMessage, streaming?: boolean): MessagePart[] {
  if (message.parts?.length) {
    const parts = streaming ? markMessagePartsStreaming(message.parts) : message.parts
    return streaming ? parts : focusFinalAssistantText(parts)
  }

  const parts: MessagePart[] = []
  if (message.thinking) parts.push({ type: 'thinking', text: message.thinking, state: streaming ? 'streaming' : 'done' })
  if (message.content) parts.push({ type: 'text', text: message.content })
  return parts
}

function focusFinalAssistantText(parts: MessagePart[]) {
  const finalTextIndex = findFinalTextIndex(parts)
  if (finalTextIndex < 0) return parts
  return parts.filter((part, index) => part.type !== 'text' || index === finalTextIndex)
}

function findFinalTextIndex(parts: MessagePart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.type === 'text' && part.text.trim().length > 0) return index
  }
  return -1
}

function markMessagePartsStreaming(parts: MessagePart[]) {
  return parts.map((part) => part.type === 'thinking' ? { ...part, state: 'streaming' as const } : part)
}

function normalizeMessagePart(value: unknown): MessagePart | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text }
  if (value.type === 'thinking' && typeof value.text === 'string') {
    return {
      type: 'thinking',
      text: value.text,
      state: value.state === 'streaming' || value.state === 'done' ? value.state : undefined,
    }
  }
  if (value.type === 'tool-call' && typeof value.name === 'string') {
    return {
      type: 'tool-call',
      id: typeof value.id === 'string' ? value.id : undefined,
      name: value.name,
      args: value.args,
      state: value.state === 'running' || value.state === 'done' || value.state === 'error' ? value.state : undefined,
    }
  }
  if (value.type === 'tool-result' && typeof value.name === 'string') {
    return {
      type: 'tool-result',
      id: typeof value.id === 'string' ? value.id : undefined,
      name: value.name,
      result: value.result,
      text: typeof value.text === 'string' ? value.text : undefined,
      isError: value.isError === true,
    }
  }
  if (value.type === 'event' && typeof value.name === 'string') {
    return { type: 'event', name: value.name, text: typeof value.text === 'string' ? value.text : undefined }
  }
  if (value.type === 'log' && (value.stream === 'stdout' || value.stream === 'stderr') && typeof value.text === 'string') {
    return { type: 'log', stream: value.stream, text: value.text }
  }

  return null
}

function parseStructuredAgentOutput(text: string) {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  let parsedAny = false
  let thinking = ''
  let content = ''
  const parts: MessagePart[] = []

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

function readToolCallPart(item: unknown): MessagePart | null {
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

function readInlineToolResultPart(item: unknown): MessagePart | null {
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

function readToolResultPart(message: Record<string, unknown>): MessagePart {
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

function readEventPart(event: Record<string, unknown>): MessagePart {
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

function formatJsonValue(value: unknown) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
