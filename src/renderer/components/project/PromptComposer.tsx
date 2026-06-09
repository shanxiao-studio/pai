import { ArrowUp, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface PromptComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
  inputDisabled?: boolean
  controls?: React.ReactNode
  className?: string
  showTopBorder?: boolean
}

export function PromptComposer({
  value,
  onChange,
  onSubmit,
  placeholder = 'User Prompt',
  disabled = false,
  inputDisabled = false,
  controls,
  className,
  showTopBorder = true,
}: PromptComposerProps) {
  return (
    <div className={cn('shrink-0 bg-background/80 px-4 py-2 backdrop-blur', showTopBorder && 'border-t', className)}>
      <div className="mx-auto flex max-w-5xl flex-col gap-2 rounded-lg border bg-[hsl(var(--surface-raised))] px-3 py-2 shadow-xl shadow-black/[0.06]">
        <div className="min-h-11">
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (!disabled) onSubmit()
              }
            }}
            placeholder={placeholder}
            disabled={inputDisabled}
            className="min-h-11 resize-none border-0 bg-transparent p-0 text-sm leading-6 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex h-8 items-center justify-between gap-3">
          <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-md text-muted-foreground" aria-label="Attach context" disabled={disabled}>
            <Plus />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            {controls && (
              <div className="flex min-w-0 items-center gap-2">
                {controls}
              </div>
            )}
            <Button size="icon" className="size-8 shrink-0 rounded-md shadow-sm" onClick={onSubmit} aria-label="Send prompt" disabled={disabled}>
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
