import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle, Circle, CircleDot, Ellipsis, LoaderCircle, Signal, SignalHigh, SignalLow, SignalMedium } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IssuePriority, IssueStatus } from '@/data/project'
import { cn } from '@/lib/utils'

export const STATUS_OPTIONS: Array<{ id: IssueStatus; title: string }> = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'done', title: 'Done' },
]

export const PRIORITY_OPTIONS: Array<{ id: IssuePriority; title: string }> = [
  { id: 'urgent', title: 'Urgent' },
  { id: 'high', title: 'High' },
  { id: 'medium', title: 'Medium' },
  { id: 'low', title: 'Low' },
  { id: 'none', title: 'No priority' },
]

export function StatusDot({ status }: { status: IssueStatus }) {
  return <Circle className={cn('size-2', status === 'backlog' ? 'stroke-dashed text-muted-foreground/35' : 'fill-current stroke-0', status === 'done' ? 'text-foreground' : status === 'in_progress' ? 'text-muted-foreground' : status === 'todo' ? 'text-muted-foreground/70' : 'text-muted-foreground/35')} />
}

export function StatusIcon({ status, showLabel = true }: { status: IssueStatus; showLabel?: boolean }) {
  const option = STATUS_OPTIONS.find((item) => item.id === status)
  const Icon = status === 'done' ? CheckCircle : status === 'in_progress' ? LoaderCircle : status === 'todo' ? CircleDot : Circle

  return (
    <span className="inline-flex h-5 items-center gap-1.5 text-xs leading-none text-muted-foreground" title={option?.title ?? status}>
      <Icon className={cn('size-4 shrink-0', status === 'backlog' && 'stroke-dashed')} />
      {showLabel && <span className="leading-none">{option?.title ?? status}</span>}
    </span>
  )
}

export function PriorityIcon({
  priority,
  compact,
  showLabel = true,
}: {
  priority: IssuePriority
  compact?: boolean
  showLabel?: boolean
}) {
  const option = PRIORITY_OPTIONS.find((item) => item.id === priority)
  const Icon = priority === 'urgent' ? Signal : priority === 'high' ? SignalHigh : priority === 'medium' ? SignalMedium : priority === 'low' ? SignalLow : Ellipsis

  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 text-xs leading-none text-muted-foreground', compact && 'justify-end')} title={option?.title ?? priority}>
      <Icon className={cn('size-4 shrink-0', priority !== 'none' && '-translate-y-0.5')} />
      {showLabel && <span className="inline-flex h-4 items-center leading-none">{option?.title ?? priority}</span>}
    </span>
  )
}

export function EditableLabels({
  labels,
  allLabels,
  onChange,
  compact,
  fullWidth,
}: {
  labels: string[]
  allLabels: string[]
  onChange: (labels: string[]) => void
  compact?: boolean
  fullWidth?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const toggleOpen = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 240
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.left)),
        top: rect.bottom + 4,
      })
    }
    setOpen((current) => !current)
  }

  const toggleLabel = (label: string) => {
    onChange(labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label])
  }

  const addLabel = () => {
    const label = newLabel.trim()
    if (!label) return
    if (!labels.includes(label)) onChange([...labels, label])
    setNewLabel('')
  }

  return (
    <div className={cn('min-w-0', compact && 'flex-1')}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        className={cn('pressable flex min-w-0 flex-wrap gap-1 rounded-md text-left', fullWidth && 'w-full px-1.5 py-1 hover:bg-muted')}
        aria-label="Edit labels"
      >
        {labels.length > 0 ? labels.map((label) => <LabelPill key={label}>{label}</LabelPill>) : <span className="text-xs text-muted-foreground">No labels</span>}
      </button>

      {open && (
        <div ref={menuRef} className="popover-enter fixed z-50 w-60 rounded-md border bg-popover p-2 shadow-xl shadow-black/10" style={position}>
          <div className="max-h-44 overflow-y-auto">
            {allLabels.length > 0 ? allLabels.map((label) => {
              const selected = labels.includes(label)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleLabel(label)}
                  className={cn('pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent', selected && 'bg-accent font-medium')}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-background">
                    {selected && <Check className="size-3" />}
                  </span>
                  <LabelPill>{label}</LabelPill>
                </button>
              )
            }) : (
              <div className="px-2 py-2 text-xs text-muted-foreground">No labels yet</div>
            )}
          </div>

          <div className="mt-2 flex gap-2 border-t pt-2">
            <Input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addLabel()
                if (event.key === 'Escape') setOpen(false)
              }}
              placeholder="New label"
              className="h-8 text-xs"
            />
            <Button type="button" size="sm" className="h-8 px-2" onClick={addLabel} disabled={!newLabel.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function StatusPicker({
  value,
  onChange,
  fullWidth,
}: {
  value: IssueStatus
  onChange: (value: IssueStatus) => void
  fullWidth?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const toggleOpen = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 144
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.left)),
        top: rect.bottom + 4,
      })
    }
    setOpen((current) => !current)
  }

  return (
    <div className={cn(fullWidth && 'w-full')}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        className={cn('pressable flex h-7 items-center rounded-md px-1.5 hover:bg-muted', fullWidth ? 'w-full' : 'w-fit')}
        aria-label="Edit status"
      >
        <StatusIcon status={value} />
      </button>
      {open && (
        <div ref={menuRef} className="popover-enter fixed z-50 w-36 rounded-md border bg-popover p-1 shadow-xl shadow-black/10" style={position}>
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
              className={cn('pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent', option.id === value && 'bg-accent font-medium')}
            >
              <StatusIcon status={option.id} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function PriorityPicker({
  value,
  onChange,
  fullWidth,
}: {
  value: IssuePriority
  onChange: (value: IssuePriority) => void
  fullWidth?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const toggleOpen = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 144
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
        top: rect.bottom + 4,
      })
    }
    setOpen((current) => !current)
  }

  return (
    <div className={cn(fullWidth && 'w-full')}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        className={cn('pressable flex h-7 items-center rounded-md px-1.5 hover:bg-muted', fullWidth ? 'w-full' : 'w-fit')}
        aria-label="Edit priority"
      >
        <PriorityIcon priority={value} />
      </button>
      {open && (
        <div ref={menuRef} className="popover-enter fixed z-50 w-36 rounded-md border bg-popover p-1 shadow-xl shadow-black/10" style={position}>
          {PRIORITY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
              className={cn('pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent', option.id === value && 'bg-accent font-medium')}
            >
              <PriorityIcon priority={option.id} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function LabelPill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">{children}</span>
}
