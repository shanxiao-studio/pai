import { ChevronRight, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AgentThreadMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  stream?: 'stderr'
}

export function AgentThread({
  messages,
  running,
  streamingMessage,
  emptyTitle,
  emptyDescription,
}: {
  messages: AgentThreadMessage[]
  running: boolean
  streamingMessage?: AgentThreadMessage | null
  emptyTitle: string
  emptyDescription: string
}) {
  const showEmpty = messages.length === 0 && !running
  const showTyping = running && !streamingMessage?.content && !streamingMessage?.thinking

  return (
    <>
      {showEmpty ? (
        <div className="flex flex-col items-center gap-3 pt-20">
          <div className="flex size-12 items-center justify-center rounded-xl border bg-muted/50">
            <Sparkles className="size-5 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">{emptyTitle}</p>
            <p className="mt-1 text-xs text-muted-foreground">{emptyDescription}</p>
          </div>
        </div>
      ) : (
        messages.map((message) => <AgentMessageBubble key={message.id} message={message} />)
      )}

      {streamingMessage && <AgentMessageBubble message={streamingMessage} streaming />}
      {showTyping && <TypingIndicator />}
    </>
  )
}

function AgentMessageBubble({ message, streaming }: { message: AgentThreadMessage; streaming?: boolean }) {
  const isUser = message.role === 'user'
  const isError = message.stream === 'stderr'

  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div className={cn('max-w-[88%] rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm shadow-black/[0.02]', isUser ? 'bg-muted text-foreground' : isError ? 'border-foreground/30 bg-muted text-foreground' : 'bg-card', streaming && 'border-dashed')}>
        {!isUser && message.thinking && (
          <details className="group mb-3 rounded-md border bg-muted/35 px-3 py-2 text-xs text-muted-foreground" open={streaming}>
            <summary className="flex cursor-pointer select-none items-center gap-1 font-medium text-foreground/75 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
              Thinking
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-sans leading-5">{message.thinking}</pre>
          </details>
        )}
        {message.content && <pre className="whitespace-pre-wrap font-sans">{message.content}</pre>}
        {streaming && <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-muted-foreground align-middle" />}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1">
      <div className="flex items-center gap-1">
        <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '0ms' }} />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '120ms' }} />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '240ms' }} />
      </div>
    </div>
  )
}
