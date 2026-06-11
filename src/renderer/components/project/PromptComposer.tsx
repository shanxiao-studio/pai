import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, FileText, MessageSquareQuote, Plus, Slash, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'
import {
  applyPromptSuggestion,
  filterPromptSuggestions,
  findPromptPrefixToken,
  type PromptPrefix,
  type PromptPrefixToken,
  type PromptSuggestion,
} from '@/shared/prompt-prefix'

type PromptComposerKeyDownEvent = {
  key: string
  shiftKey: boolean
  nativeEvent: {
    isComposing?: boolean
    keyCode?: number
  }
}

interface PromptComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value?: string) => void
  placeholder?: string
  disabled?: boolean
  inputDisabled?: boolean
  controls?: React.ReactNode
  attachments?: React.ReactNode
  onAttach?: () => void
  projectPath?: string
  className?: string
  showTopBorder?: boolean
}

const COMMAND_SUGGESTIONS: PromptSuggestion[] = [
  { id: '/help', prefix: '/', label: '/help', value: '/help', detail: 'command', description: 'Show available chat commands' },
  { id: '/summarize', prefix: '/', label: '/summarize', value: 'Summarize the current context and suggest next steps.', detail: 'command' },
  { id: '/plan', prefix: '/', label: '/plan', value: 'Create a concise implementation plan before making changes.', detail: 'command' },
  { id: '/review', prefix: '/', label: '/review', value: 'Review the current changes for bugs, regressions, and missing tests.', detail: 'command' },
]

const QUICK_REPLY_SUGGESTIONS: PromptSuggestion[] = [
  { id: '!continue', prefix: '!', label: '!continue', value: 'Continue with the next step.', detail: 'quick reply' },
  { id: '!tests', prefix: '!', label: '!tests', value: 'Run the relevant tests and summarize the result.', detail: 'quick reply' },
  { id: '!simplify', prefix: '!', label: '!simplify', value: 'Simplify this approach and keep the change minimal.', detail: 'quick reply' },
  { id: '!explain', prefix: '!', label: '!explain', value: 'Explain the tradeoffs and the recommended path.', detail: 'quick reply' },
]

export function shouldSubmitPromptOnKeyDown(event: PromptComposerKeyDownEvent) {
  const isImeComposing = event.nativeEvent.isComposing === true || event.nativeEvent.keyCode === 229
  return event.key === 'Enter' && !event.shiftKey && !isImeComposing
}

export function PromptComposer({
  value,
  onChange,
  onSubmit,
  placeholder = 'User Prompt',
  disabled = false,
  inputDisabled = false,
  controls,
  attachments,
  onAttach,
  projectPath,
  className,
  showTopBorder = true,
}: PromptComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursor, setCursor] = useState(0)
  const [token, setToken] = useState<PromptPrefixToken | null>(null)
  const [skillSuggestions, setSkillSuggestions] = useState<PromptSuggestion[]>([])
  const [fileSuggestions, setFileSuggestions] = useState<PromptSuggestion[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  const submitCurrentValue = (valueToSubmit: string) => {
    if (!disabled) onSubmit(valueToSubmit)
  }

  const updateToken = useCallback((nextValue: string, nextCursor: number) => {
    setCursor(nextCursor)
    setToken(findPromptPrefixToken(nextValue, nextCursor))
    setActiveIndex(0)
  }, [])

  useEffect(() => {
    updateToken(value, cursor)
  }, [cursor, updateToken, value])

  useEffect(() => {
    if (!projectPath || token?.prefix !== '$') {
      setSkillSuggestions([])
      return
    }

    let cancelled = false
    void electronClient?.listPromptSkills(projectPath)
      .then((skills) => {
        if (cancelled) return
        setSkillSuggestions(skills.map((skill) => ({
          id: `$${skill.source}:${skill.name}`,
          prefix: '$',
          label: `$${skill.name}`,
          value: `$${skill.name}`,
          detail: skill.source,
          description: skill.description,
        })))
      })
      .catch(() => {
        if (!cancelled) setSkillSuggestions([])
      })

    return () => {
      cancelled = true
    }
  }, [projectPath, token?.prefix])

  useEffect(() => {
    if (!projectPath || token?.prefix !== '@') {
      setFileSuggestions([])
      return
    }

    let cancelled = false
    void electronClient?.searchProjectFiles(projectPath, token.query)
      .then((files) => {
        if (cancelled) return
        setFileSuggestions(files.map((file) => ({
          id: `@${file}`,
          prefix: '@',
          label: `@${file}`,
          value: `@${file}`,
          detail: 'file',
        })))
      })
      .catch(() => {
        if (!cancelled) setFileSuggestions([])
      })

    return () => {
      cancelled = true
    }
  }, [projectPath, token?.prefix, token?.query])

  const suggestions = useMemo(() => filterPromptSuggestions([
    ...COMMAND_SUGGESTIONS,
    ...QUICK_REPLY_SUGGESTIONS,
    ...skillSuggestions,
    ...fileSuggestions,
  ], token), [fileSuggestions, skillSuggestions, token])

  const applySuggestion = useCallback((suggestion: PromptSuggestion) => {
    if (!token) return
    const result = applyPromptSuggestion(value, token, suggestion.value)
    onChange(result.value)
    setToken(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(result.cursor, result.cursor)
      setCursor(result.cursor)
    })
  }, [onChange, token, value])

  const activeSuggestion = suggestions[activeIndex]

  return (
    <div className={cn('shrink-0 bg-background/80 px-4 py-2 backdrop-blur', showTopBorder && 'border-t', className)}>
      <div className="relative mx-auto flex max-w-5xl flex-col gap-2 rounded-lg border bg-[hsl(var(--surface-raised))] px-3 py-2 shadow-xl shadow-black/[0.06]">
        {attachments}
        <div className="min-h-11">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
              updateToken(event.target.value, event.target.selectionStart)
            }}
            onClick={(event) => updateToken(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyUp={(event) => {
              if (isSuggestionNavigationKey(event.key)) return
              updateToken(event.currentTarget.value, event.currentTarget.selectionStart)
            }}
            onKeyDown={(event) => {
              if (suggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActiveIndex((index) => (index + 1) % suggestions.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (event.key === 'Tab' || event.key === 'Enter') {
                  event.preventDefault()
                  if (activeSuggestion) applySuggestion(activeSuggestion)
                  return
                }
                if (event.key === 'Escape') {
                  setToken(null)
                  return
                }
              }
              if (shouldSubmitPromptOnKeyDown(event)) {
                event.preventDefault()
                submitCurrentValue(event.currentTarget.value)
              }
            }}
            placeholder={placeholder}
            disabled={inputDisabled}
            className="min-h-11 resize-none border-0 bg-transparent p-0 text-sm leading-6 shadow-none focus-visible:ring-0"
          />
        </div>
        {suggestions.length > 0 && (
          <div className="popover-enter absolute inset-x-0 bottom-full z-20 mb-2 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-xl shadow-black/10">
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  applySuggestion(suggestion)
                }}
                className={cn(
                  'pressable flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 hover:text-accent-foreground',
                )}
              >
                <SuggestionIcon prefix={suggestion.prefix} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{suggestion.label}</span>
                  {suggestion.description && <span className="block truncate text-muted-foreground">{suggestion.description}</span>}
                </span>
                {suggestion.detail && <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{suggestion.detail}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex h-8 items-center justify-between gap-3">
          <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-md text-muted-foreground" aria-label="Attach file" disabled={disabled || !onAttach} onClick={onAttach}>
            <Plus />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            {controls && (
              <div className="flex min-w-0 items-center gap-2">
                {controls}
              </div>
            )}
            <Button size="icon" className="size-8 shrink-0 rounded-md shadow-sm" onClick={() => submitCurrentValue(value)} aria-label="Send prompt" disabled={disabled}>
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SuggestionIcon({ prefix }: { prefix: PromptPrefix }) {
  if (prefix === '$') return <Sparkles className="size-3.5 shrink-0" />
  if (prefix === '@') return <FileText className="size-3.5 shrink-0" />
  if (prefix === '!') return <MessageSquareQuote className="size-3.5 shrink-0" />
  return <Slash className="size-3.5 shrink-0" />
}

function isSuggestionNavigationKey(key: string) {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Tab' || key === 'Escape'
}
