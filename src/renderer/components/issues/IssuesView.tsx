import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Circle, Columns3, Folder, List, LoaderCircle, Plus, StopCircle, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MessageBubble, type ChatMessage, type MessagePart } from '@/components/chat/MessageSurface'
import { AttachmentPreviewImage } from '@/components/chat/AttachmentPreviewImage'
import { ProjectTabs } from '@/components/project/ProjectTabs'
import { PromptComposer } from '@/components/project/PromptComposer'
import { PropertyField, PropertyPanel } from '@/components/project/PropertyPanel'
import { useProjects } from '@/components/project/ProjectProvider'
import { EditableLabels, PRIORITY_OPTIONS, PriorityPicker, STATUS_OPTIONS, StatusDot, StatusPicker } from '@/components/issues/IssueControls'
import { Issue, IssuePriority, IssueStatus, ProjectConfig } from '@/data/project'
import { cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'
import { buildPromptWithAttachments, formatBytes, formatRejectedAttachments } from '@/shared/chat-attachments'
import {
  consumeAgentOutput,
  countRenderableAssistantMessages,
  createAssistantStreamState,
  finalizeAssistantStream,
  hasEquivalentMessage,
  hasAssistantStreamContent,
  normalizeLogMessages,
  type AgentOutputPayload,
} from '@/shared/agent-output'

const ISSUE_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'done']
const ISSUE_PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low', 'none']

type AgentRunStatus = 'idle' | 'running' | 'succeeded' | 'failed'

type EngineSnapshot = {
  sessions: { running: string[] }
  issueRuns: {
    queued: Array<{ key: string; projectPath: string; issueId: string; title: string; attempt?: number; lastError?: string | null }>
    running: Array<{
      key: string
      projectPath: string
      issueId: string
      title: string
      startedAt: string
      attempt?: number
      sessionId?: string | null
      threadId?: string | null
      turnId?: string | null
      lastError?: string | null
      tokenUsage?: {
        inputTokens: number
        outputTokens: number
        reasoningOutputTokens: number
        cachedInputTokens: number
        totalTokens: number
      } | null
    }>
    retrying: Array<{
      key: string
      projectPath: string
      issueId: string
      title: string
      attempt?: number
      nextRetryAt?: string | null
      lastError?: string | null
      sessionId?: string | null
      threadId?: string | null
      turnId?: string | null
      tokenUsage?: {
        inputTokens: number
        outputTokens: number
        reasoningOutputTokens: number
        cachedInputTokens: number
        totalTokens: number
      } | null
    }>
    maxConcurrent: number
    claimedCount: number
  }
}

type IssueViewMode = 'list' | 'board'

const ISSUE_VIEW_MODE_KEY = 'pai.issue.viewMode'

export function IssuesView() {
  const { issueId } = useParams()
  if (issueId) return <IssueDetailPage issueId={issueId} />

  return <IssueListPage />
}

function IssueListPage() {
  const { name } = useParams()
  const { getProject, projects } = useProjects()
  const project = getProject(name)
  const [issues, setIssues] = useState<Issue[]>([])
  const [showNew, setShowNew] = useState(false)
  const [issueMenu, setIssueMenu] = useState<{ issue: Issue; x: number; y: number } | null>(null)
  const allLabels = useMemo(() => uniqueLabels(issues), [issues])
  const [viewMode, setViewMode] = useState<IssueViewMode>(() => {
    const stored = localStorage.getItem(ISSUE_VIEW_MODE_KEY)
    return stored === 'board' ? 'board' : 'list'
  })

  useEffect(() => {
    localStorage.setItem(ISSUE_VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  const loadIssues = useCallback(async () => {
    if (!project?.path) return
    const loadedIssues = await electronClient?.readIssues(project.path)
    if (loadedIssues) setIssues(loadedIssues.map(normalizeIssue))
  }, [project?.path])

  useEffect(() => {
    void loadIssues()
  }, [loadIssues])

  useEffect(() => {
    if (!project?.path) return
    const projectPath = project.path
    return electronClient?.onProjectIssuesChanged((data) => {
      if (data.projectPath !== projectPath) return
      void loadIssues()
    })
  }, [loadIssues, project?.path])

  useEffect(() => {
    if (!project?.path) return

    const projectPath = project.path
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    electronClient?.watchProject(projectPath, (data) => {
      if (data.projectPath !== projectPath || cancelled) return
      void loadIssues()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [loadIssues, project?.path])

  useEffect(() => {
    const closeMenu = () => setIssueMenu(null)
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [])

  const saveIssues = useCallback(async (updated: Issue[]) => {
    setIssues(updated)
    if (!project?.path) return
    const saved = await electronClient?.writeIssues(project.path, updated)
    if (saved) setIssues(saved.map(normalizeIssue))
  }, [project?.path])

  const handleCreate = useCallback(async (targetProject: ProjectConfig | undefined, issue: Issue) => {
    const normalized = normalizeIssue(issue)
    const targetPath = targetProject?.path

    if (!targetPath || targetPath === project?.path) {
      await saveIssues([...issues, normalized])
      setShowNew(false)
      return
    }

    const targetIssues = await electronClient?.readIssues(targetPath)
    if (!targetIssues) return
    await electronClient?.writeIssues(targetPath, [...targetIssues.map(normalizeIssue), normalized])
    setShowNew(false)
  }, [issues, project?.path, saveIssues])

  const handleDeleteIssue = useCallback(async (issueId: string) => {
    setIssueMenu(null)
    await saveIssues(issues.filter((issue) => issue.id !== issueId))
  }, [issues, saveIssues])

  const handleIssueChange = useCallback(async (issueId: string, patch: Partial<Issue>) => {
    const updated = issues.map((issue) => (issue.id === issueId ? normalizeIssue({ ...issue, ...patch }) : issue))
    await saveIssues(updated)
  }, [issues, saveIssues])

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectTabs />
      <div className="flex items-center justify-between border-b bg-background/80 py-4 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">Issues</h1>
          <p className="text-sm text-muted-foreground">{issues.length} issue{issues.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-8 items-center rounded-md border bg-muted/45 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={cn('pressable flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-muted-foreground', viewMode === 'list' && 'bg-background text-foreground shadow-sm')}
            >
              <List className="size-3.5" />
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('board')}
              className={cn('pressable flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-muted-foreground', viewMode === 'board' && 'bg-background text-foreground shadow-sm')}
            >
              <Columns3 className="size-3.5" />
              Board
            </button>
          </div>
          <Button size="sm" className="gap-2 shadow-sm" onClick={() => setShowNew(true)}>
            <Plus className="size-3.5" />
            New Issue
          </Button>
        </div>
      </div>

      {viewMode === 'list' ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="content-enter mx-auto flex w-full max-w-6xl flex-col py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
            <IssueList
              issues={issues}
              onIssueChange={handleIssueChange}
              onIssueContextMenu={(event, issue) => {
                event.preventDefault()
                setIssueMenu({ issue, x: event.clientX, y: event.clientY })
              }}
            />
            {issues.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-20 text-center">
                <Circle className="size-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No issues yet</p>
                <p className="text-xs text-muted-foreground">Create an issue to start tracking agent work.</p>
              </div>
            )}
          </div>
        </ScrollArea>
      ) : issues.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7 text-center">
          <Circle className="size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">No issues yet</p>
          <p className="text-xs text-muted-foreground">Create an issue to start tracking agent work.</p>
        </div>
      ) : (
        <div className="content-enter flex min-h-0 flex-1 overflow-x-auto py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
          <IssueBoard
            issues={issues}
            onIssueChange={handleIssueChange}
            onIssueContextMenu={(event, issue) => {
              event.preventDefault()
              setIssueMenu({ issue, x: event.clientX, y: event.clientY })
            }}
          />
        </div>
      )}

      {showNew && (
        <NewIssueDialog
          projects={projects}
          defaultProject={project}
          projectName={project?.name ?? name ?? 'Unknown project'}
          allLabels={allLabels}
          onClose={() => setShowNew(false)}
          onCreate={handleCreate}
        />
      )}
      {issueMenu && (
        <div
          className="popover-enter fixed z-50 w-36 rounded-md border bg-popover p-1 shadow-xl shadow-black/10"
          style={{ left: issueMenu.x, top: issueMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => handleDeleteIssue(issueMenu.issue.id)}
            className="pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
            <span>Delete Issue</span>
          </button>
        </div>
      )}
    </div>
  )
}

function IssueList({
  issues,
  onIssueChange,
  onIssueContextMenu,
}: {
  issues: Issue[]
  onIssueChange: (issueId: string, patch: Partial<Issue>) => void
  onIssueContextMenu: (event: React.MouseEvent, issue: Issue) => void
}) {
  if (issues.length === 0) return null
  const allLabels = uniqueLabels(issues)

  return (
    <>
      <div className="grid grid-cols-[minmax(260px,1fr)_220px_150px_130px] border-b bg-background/70 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>Title</div>
        <div>Labels</div>
        <div>Status</div>
        <div>Priority</div>
      </div>
      <div className="divide-y rounded-b-lg border-x border-b bg-[hsl(var(--surface-raised))]">
        {issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} allLabels={allLabels} onIssueChange={onIssueChange} onContextMenu={onIssueContextMenu} />
        ))}
      </div>
    </>
  )
}

function IssueRow({
  issue,
  allLabels,
  onIssueChange,
  onContextMenu,
}: {
  issue: Issue
  allLabels: string[]
  onIssueChange: (issueId: string, patch: Partial<Issue>) => void
  onContextMenu: (event: React.MouseEvent, issue: Issue) => void
}) {
  return (
    <div
      className="grid grid-cols-[minmax(260px,1fr)_220px_150px_130px] items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/35"
      onContextMenu={(event) => onContextMenu(event, issue)}
    >
      <Link to={`${issue.id}`} className="min-w-0 truncate font-medium hover:text-primary">
        {issue.title}
      </Link>
      <EditableLabels labels={issue.labels} allLabels={allLabels} onChange={(labels) => onIssueChange(issue.id, { labels })} />
      <StatusPicker value={issue.status} onChange={(status) => onIssueChange(issue.id, { status })} />
      <PriorityPicker value={issue.priority} onChange={(priority) => onIssueChange(issue.id, { priority })} />
    </div>
  )
}

function IssueBoard({
  issues,
  onIssueChange,
  onIssueContextMenu,
}: {
  issues: Issue[]
  onIssueChange: (issueId: string, patch: Partial<Issue>) => void
  onIssueContextMenu: (event: React.MouseEvent, issue: Issue) => void
}) {
  const allLabels = uniqueLabels(issues)
  const [draggedIssueId, setDraggedIssueId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<IssueStatus | null>(null)

  if (issues.length === 0) return null

  const handleDrop = (event: React.DragEvent, status: IssueStatus) => {
    event.preventDefault()
    const issueId = event.dataTransfer.getData('text/plain') || draggedIssueId
    setDraggedIssueId(null)
    setDragOverStatus(null)

    const issue = issues.find((item) => item.id === issueId)
    if (!issue || issue.status === status) return
    onIssueChange(issue.id, { status })
  }

  return (
    <div className="grid h-full w-full min-w-[920px] grid-cols-4 gap-3">
      {STATUS_OPTIONS.map((status) => {
        const statusIssues = issues.filter((issue) => issue.status === status.id)
        const isDropTarget = dragOverStatus === status.id

        return (
          <section
            key={status.id}
            className={cn('flex min-h-0 flex-col rounded-lg border bg-muted/25 shadow-sm shadow-black/[0.02] transition-[background-color,border-color,box-shadow,transform] duration-150 [transition-timing-function:var(--ease-out)]', isDropTarget && 'border-primary/50 bg-primary/5 shadow-md')}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDragOverStatus(status.id)
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget as Node | null
              if (nextTarget && event.currentTarget.contains(nextTarget)) return
              setDragOverStatus((current) => (current === status.id ? null : current))
            }}
            onDrop={(event) => handleDrop(event, status.id)}
          >
            <div className="flex h-10 shrink-0 items-center justify-between px-3">
              <div className="flex items-center gap-2">
                <StatusDot status={status.id} />
                <h2 className="text-sm font-semibold">{status.title}</h2>
              </div>
              <span className="rounded bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{statusIssues.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {statusIssues.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  allLabels={allLabels}
                  dragging={draggedIssueId === issue.id}
                  onIssueChange={onIssueChange}
                  onContextMenu={onIssueContextMenu}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', issue.id)
                    setDraggedIssueId(issue.id)
                  }}
                  onDragEnd={() => {
                    setDraggedIssueId(null)
                    setDragOverStatus(null)
                  }}
                />
              ))}
              {statusIssues.length === 0 && (
                <div className={cn('flex min-h-24 items-center justify-center rounded-md border border-dashed bg-background/45 text-xs text-muted-foreground transition-colors', isDropTarget && 'border-primary/50 bg-primary/10 text-foreground')}>
                  No issues
                </div>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function IssueCard({
  issue,
  allLabels,
  dragging,
  onIssueChange,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  issue: Issue
  allLabels: string[]
  dragging: boolean
  onIssueChange: (issueId: string, patch: Partial<Issue>) => void
  onContextMenu: (event: React.MouseEvent, issue: Issue) => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)

  const handleDragStart = (event: React.DragEvent) => {
    if (cardRef.current) setCardDragImage(event, cardRef.current)
    onDragStart(event)
  }

  return (
    <article
      ref={cardRef}
      draggable
      aria-grabbed={dragging}
      className={cn('pressable cursor-grab rounded-md border bg-[hsl(var(--surface-raised))] p-3 shadow-sm shadow-black/[0.025] hover:border-muted-foreground/30 active:cursor-grabbing active:scale-[0.99]', dragging && 'opacity-55')}
      onContextMenu={(event) => onContextMenu(event, issue)}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <Link to={`${issue.id}`} className="block truncate text-sm font-medium leading-5 hover:text-primary">
        {issue.title}
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <EditableLabels labels={issue.labels} allLabels={allLabels} onChange={(labels) => onIssueChange(issue.id, { labels })} compact />
        <PriorityPicker value={issue.priority} onChange={(priority) => onIssueChange(issue.id, { priority })} />
      </div>
    </article>
  )
}

function setCardDragImage(event: React.DragEvent, card: HTMLElement) {
  const rect = card.getBoundingClientRect()
  event.dataTransfer.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top)
}

function ProjectPicker({
  projects,
  value,
  fallbackName,
  onChange,
  fullWidth,
}: {
  projects: ProjectConfig[]
  value: ProjectConfig | undefined
  fallbackName: string
  onChange: (project: ProjectConfig | undefined) => void
  fullWidth?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedName = value?.name ?? fallbackName

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
      const menuWidth = 200
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
        className={cn('pressable flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted', fullWidth && 'w-full')}
        aria-label="Edit project"
      >
        <Folder className="size-4 shrink-0" />
        <span className="min-w-0 truncate" title={selectedName}>{selectedName}</span>
      </button>
      {open && (
        <div ref={menuRef} className="popover-enter fixed z-50 max-h-56 w-52 overflow-y-auto rounded-md border bg-popover p-1 shadow-xl shadow-black/10" style={position}>
          {projects.length > 0 ? projects.map((project) => {
            const selected = project.path ? project.path === value?.path : project.slug === value?.slug
            return (
              <button
                key={project.path ?? project.slug}
                type="button"
                onClick={() => {
                  onChange(project)
                  setOpen(false)
                }}
                className={cn('pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent', selected && 'bg-accent font-medium')}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{project.name}</span>
              </button>
            )
          }) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">No projects</div>
          )}
        </div>
      )}
    </div>
  )
}

function NewIssueDialog({
  projects,
  defaultProject,
  projectName,
  allLabels,
  onClose,
  onCreate,
}: {
  projects: ProjectConfig[]
  defaultProject: ProjectConfig | undefined
  projectName: string
  allLabels: string[]
  onClose: () => void
  onCreate: (project: ProjectConfig | undefined, issue: Issue) => void | Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [status, setStatus] = useState<IssueStatus>('backlog')
  const [priority, setPriority] = useState<IssuePriority>('none')
  const [selectedProject, setSelectedProject] = useState<ProjectConfig | undefined>(() => defaultProject ?? projects[0])

  useEffect(() => {
    setSelectedProject((current) => current ?? defaultProject ?? projects[0])
  }, [defaultProject, projects])

  const createIssue = () => {
    if (!title.trim()) return
    void onCreate(selectedProject, normalizeIssue({
      id: `issue-${Date.now()}`,
      title: title.trim(),
      status,
      priority,
      labels,
      detail: detail.trim(),
      attributes: {},
    }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div className="modal-enter w-full max-w-md rounded-lg border bg-background p-6 shadow-xl shadow-black/10" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">New Issue</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Issue title"
              autoFocus
              onKeyDown={(event) => { if (event.key === 'Enter') createIssue() }}
              className="h-auto border-0 px-0 py-0 text-xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
            />
            <Textarea
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder="Issue details..."
              className="min-h-[112px] resize-none rounded-none border-0 bg-transparent px-0 py-0 text-sm leading-6 shadow-none hover:border-transparent focus-visible:ring-0"
            />
          </div>
          <div className="grid grid-cols-[minmax(0,max-content)_repeat(3,minmax(0,1fr))] items-start gap-3 border-t pt-4">
            <InlineIssueProperty>
              <ProjectPicker projects={projects} value={selectedProject} fallbackName={projectName} onChange={setSelectedProject} />
            </InlineIssueProperty>
            <InlineIssueProperty>
              <StatusPicker value={status} onChange={setStatus} fullWidth />
            </InlineIssueProperty>
            <InlineIssueProperty>
              <PriorityPicker value={priority} onChange={setPriority} fullWidth />
            </InlineIssueProperty>
            <InlineIssueProperty>
              <EditableLabels labels={labels} allLabels={allLabels} onChange={setLabels} compact fullWidth />
            </InlineIssueProperty>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={createIssue} disabled={!title.trim()}>
              <Plus className="mr-1 size-3.5" />
              Create
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function InlineIssueProperty({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 [&>*]:w-full">{children}</div>
  )
}

function IssueDetailPage({ issueId }: { issueId: string }) {
  const { name } = useParams()
  const navigate = useNavigate()
  const { getProject, projects } = useProjects()
  const project = getProject(name)
  const issueListPath = name ? `/project/${name}/issues` : '/issues'
  const [issues, setIssues] = useState<Issue[]>([])
  const [logs, setLogs] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>('idle')
  const [assistantContent, setAssistantContent] = useState('')
  const [assistantThinking, setAssistantThinking] = useState('')
  const [assistantParts, setAssistantParts] = useState<MessagePart[]>([])
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentNotice, setAttachmentNotice] = useState('')
  const [engineSnapshot, setEngineSnapshot] = useState<EngineSnapshot | null>(null)
  const saveTimer = useRef<number | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const unsubs = useRef<Array<() => void>>([])
  const issueStateLoadSeq = useRef(0)
  const logsRef = useRef<ChatMessage[]>([])

  const loadIssueState = useCallback(async () => {
    if (!project?.path) return
    const projectPath = project.path
    const nextSeq = issueStateLoadSeq.current + 1
    issueStateLoadSeq.current = nextSeq
    const [loadedIssues, loadedLogs, status] = await Promise.all([
      electronClient?.readIssues(projectPath) ?? Promise.resolve([]),
      electronClient?.readIssueLogs(projectPath, issueId) ?? Promise.resolve([]),
      electronClient?.getAgentStatus(issueSessionId(issueId)) ?? Promise.resolve({ running: false }),
    ])
    if (issueStateLoadSeq.current !== nextSeq) return null
    const normalizedLogs = normalizeLogMessages(loadedLogs)
    setIssues(loadedIssues.map(normalizeIssue))
    setLogs(normalizedLogs)
    setRunning(status.running)
    setAgentRunStatus(status.running ? 'running' : inferAgentRunStatus(normalizedLogs))
    return normalizedLogs
  }, [project?.path, issueId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!project?.path) return
      const [loadedIssues, loadedLogs, status] = await Promise.all([
        electronClient?.readIssues(project.path) ?? Promise.resolve([]),
        electronClient?.readIssueLogs(project.path, issueId) ?? Promise.resolve([]),
        electronClient?.getAgentStatus(issueSessionId(issueId)) ?? Promise.resolve({ running: false }),
      ])
      if (cancelled) return
      setIssues(loadedIssues.map(normalizeIssue))
      setLogs(normalizeLogMessages(loadedLogs))
      setRunning(status.running)
      setAgentRunStatus(status.running ? 'running' : inferAgentRunStatus(normalizeLogMessages(loadedLogs)))
    })()

    return () => {
      cancelled = true
    }
  }, [project?.path, issueId])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ block: 'end' }) }, [logs, assistantContent, assistantThinking, assistantParts, running])
  useEffect(() => { logsRef.current = logs }, [logs])
  useEffect(() => () => unsubs.current.forEach((fn) => fn()), [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function refresh() {
      const snapshot = await electronClient?.getEngineSnapshot()
      if (!cancelled && snapshot) setEngineSnapshot(snapshot)
    }

    void refresh()
    timer = window.setInterval(refresh, 1500)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!project?.path) return
    const projectPath = project.path
    return electronClient?.onProjectIssuesChanged((data) => {
      if (data.projectPath !== projectPath) return
      void loadIssueState()
    })
  }, [loadIssueState, project?.path])

  useEffect(() => {
    if (!project?.path) return

    const projectPath = project.path
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    electronClient?.watchProject(projectPath, (data) => {
      if (data.projectPath !== projectPath || cancelled) return
      void loadIssueState()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [loadIssueState, project?.path])

  useEffect(() => {
    const runId = issueSessionId(issueId)
    let passiveAssistantState = createAssistantStreamState()
    let passiveAssistantBaselineCount: number | null = null
    const unsubscribeOutput = electronClient?.onAgentOutput((data) => {
      if (data.sessionId !== runId || unsubs.current.length > 0) return
      passiveAssistantBaselineCount ??= countRenderableAssistantMessages(logsRef.current)
      passiveAssistantState = consumeAgentOutput(passiveAssistantState, data as AgentOutputPayload)
      setRunning(true)
      setAgentRunStatus('running')
      setAssistantThinking(passiveAssistantState.thinking)
      setAssistantContent(passiveAssistantState.content)
      setAssistantParts(passiveAssistantState.parts)
    })
    const unsubscribeDone = electronClient?.onAgentDone(async (data) => {
      if (data.sessionId !== runId) return
      const assistantMsg = hasAssistantStreamContent(passiveAssistantState) || data.error
        ? finalizeAssistantStream(passiveAssistantState, data.error)
        : null
      const refreshedLogs = await loadIssueState()
      if (
        assistantMsg &&
        (
          !refreshedLogs ||
          (
            !hasEquivalentMessage(refreshedLogs, assistantMsg) &&
            countRenderableAssistantMessages(refreshedLogs) <= (passiveAssistantBaselineCount ?? countRenderableAssistantMessages(logsRef.current))
          )
        )
      ) {
        setLogs((prev) => [...prev, assistantMsg])
      }
      passiveAssistantState = createAssistantStreamState()
      passiveAssistantBaselineCount = null
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
    })
    return () => {
      unsubscribeOutput?.()
      unsubscribeDone?.()
    }
  }, [project?.path, issueId])

  const issue = useMemo(() => issues.find((item) => item.id === issueId), [issueId, issues])
  const allLabels = useMemo(() => uniqueLabels(issues), [issues])
  const hasStreamingMessage = hasAssistantStreamContent({
    content: assistantContent,
    thinking: assistantThinking,
    parts: assistantParts,
  })
  const selectedProject = useMemo(() => {
    if (!project) return undefined
    return projects.find((item) => (
      project.path
        ? item.path === project.path
        : item.slug === project.slug
    )) ?? project
  }, [project, projects])

  const persistIssues = useCallback((updated: Issue[]) => {
    setIssues(updated)
    if (!project?.path) return
    const projectPath = project.path
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const saved = await electronClient?.writeIssues(projectPath, updated)
      if (saved) setIssues(saved.map(normalizeIssue))
    }, 400)
  }, [project?.path])

  const patchIssue = useCallback((patch: Partial<Issue>) => {
    const previous = issues.find((item) => item.id === issueId)
    const updated = issues.map((item) => (item.id === issueId ? normalizeIssue({ ...item, ...patch }) : item))
    persistIssues(updated)
    if (shouldAutoExecuteIssue(previous, patch) && !running) {
      setRunning(true)
      setAgentRunStatus('running')
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
    }
  }, [issueId, issues, persistIssues, running])

  const moveIssueToProject = useCallback(async (nextProject: ProjectConfig | undefined) => {
    if (!project?.path || !nextProject?.path) return
    if ((nextProject.path && nextProject.path === project.path) || (!nextProject.path && nextProject.slug === project.slug)) return

    await electronClient?.moveIssue({
      fromProjectPath: project.path,
      toProjectPath: nextProject.path,
      issueId,
    })
    navigate(`/project/${nextProject.slug}/issues/${issueId}`)
  }, [issueId, navigate, project?.path, project?.slug])

  const handleAttach = useCallback(async () => {
    const result = await electronClient?.selectAttachments(attachments)
    if (!result) return
    if (result.accepted.length > 0) {
      setAttachments((current) => [...current, ...result.accepted])
    }
    setAttachmentNotice(formatRejectedAttachments(result.rejected))
  }, [attachments])

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path))
    setAttachmentNotice('')
  }, [])

  const handleSubmit = useCallback(async (submittedValue?: string) => {
    const msg = (submittedValue ?? input).trim()
    if ((!msg && attachments.length === 0) || running || !project?.path || !issue) return
    const projectPath = project.path
    const submittedAttachments = attachments
    const userPrompt = buildPromptWithAttachments(msg, submittedAttachments)
    const agentPrompt = buildIssuePrompt(issue, logs, userPrompt)
    setInput('')
    setAttachments([])
    setAttachmentNotice('')
    setAssistantContent('')
    setAssistantThinking('')
    setAssistantParts([])
    setRunning(true)
    setAgentRunStatus('running')
    const userMessage: ChatMessage = {
      id: String(Date.now()),
      role: 'user',
      content: msg,
      parts: [
        ...(msg ? [{ type: 'text' as const, text: msg }] : []),
        ...submittedAttachments,
      ],
    }
    setLogs((prev) => [...prev, userMessage])
    const cfg = await electronClient?.readAgentConfig(projectPath)
    const { agentKind, model, thinking } = readAgentSettings(cfg)
    const runId = issueSessionId(issueId)
    const assistantMessagesBeforeRun = countRenderableAssistantMessages(logs)
    let assistantState = createAssistantStreamState()
    unsubs.current = []
    unsubs.current.push(electronClient!.onAgentOutput((data) => {
      if (data.sessionId !== runId) return
      assistantState = consumeAgentOutput(assistantState, data as AgentOutputPayload)
      setAssistantThinking(assistantState.thinking)
      setAssistantContent(assistantState.content)
      setAssistantParts(assistantState.parts)
    }))
    unsubs.current.push(electronClient!.onAgentDone(async (data) => {
      if (data.sessionId !== runId) return
      unsubs.current.forEach((fn) => fn())
      unsubs.current = []
      const assistantMsg = hasAssistantStreamContent(assistantState) || data.error
        ? finalizeAssistantStream(assistantState, data.error)
        : null
      const refreshedLogs = await loadIssueState()
      if (
        assistantMsg &&
        (
          !refreshedLogs ||
          (
            !hasEquivalentMessage(refreshedLogs, assistantMsg) &&
            countRenderableAssistantMessages(refreshedLogs) <= assistantMessagesBeforeRun
          )
        )
      ) {
        setLogs((prev) => [...prev, assistantMsg])
      }
      setRunning(false)
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
      setAgentRunStatus(data.exitCode === 0 ? 'succeeded' : 'failed')
    }))
    try {
      await electronClient!.startChat({
        agentKind,
        model,
        thinking,
        message: agentPrompt,
        userMessage: msg,
        attachments: submittedAttachments,
        workspacePath: projectPath,
        sessionId: runId,
      })
    } catch (error) {
      unsubs.current.forEach((fn) => fn())
      unsubs.current = []
      const message = error instanceof Error ? error.message : 'Failed to start agent'
      setLogs((prev) => [...prev, {
        id: String(Date.now()),
        role: 'assistant',
        content: message,
        stream: 'stderr',
        parts: [{ type: 'log', stream: 'stderr', text: message }],
      }])
      setRunning(false)
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
      setAgentRunStatus('failed')
    }
  }, [input, attachments, issue, issueId, loadIssueState, logs, project?.path, running])

  const handleCancel = useCallback(async () => {
    await electronClient?.cancelChat(issueSessionId(issueId))
  }, [issueId])

  if (!issue) {
    return (
      <div className="flex h-full flex-col bg-background">
        <ProjectTabs />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Issue not found.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectTabs />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] pr-8 backdrop-blur">
        <Button variant="ghost" size="icon" className="size-7" asChild>
          <Link to={issueListPath} aria-label="Back to issue list"><ArrowLeft className="size-3.5" /></Link>
        </Button>
        <span className="text-sm text-muted-foreground">Issues</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="truncate text-sm font-medium">{issue.title}</span>
      </div>
      <div className="flex min-h-0 flex-1 bg-background/65">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <section className="content-enter mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-4 pb-3 pt-6 pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] pr-8 lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10">
            <Input
              value={issue.title}
              onChange={(event) => patchIssue({ title: event.target.value })}
              className="h-auto border-0 px-0 py-0 text-xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
            />
            <Textarea
              value={issue.detail}
              onChange={(event) => patchIssue({ detail: event.target.value })}
              placeholder="Add issue details..."
              className="min-h-24 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-sm leading-6 shadow-none hover:border-transparent focus-visible:ring-0"
            />
          </section>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 bg-background/90 backdrop-blur">
              <div className="mx-auto w-full max-w-5xl px-8 pb-4 pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10">
                <div className="flex items-center gap-2 border-t pt-4">
                  <h2 className="text-sm font-semibold">Agent work</h2>
                  <AgentRunStatusBadge status={agentRunStatus} />
                </div>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-8 pb-5 pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10">
                {logs.map((entry) => <MessageBubble key={entry.id} message={entry} />)}
                {logs.length === 0 && <p className="rounded-lg border bg-[hsl(var(--surface-raised))] p-4 text-sm text-muted-foreground shadow-sm shadow-black/[0.02]">No agent work recorded yet.</p>}
                {running && hasStreamingMessage && (
                  <MessageBubble
                    message={{ id: 'stream', role: 'assistant', content: assistantContent, thinking: assistantThinking, parts: assistantParts }}
                    streaming
                  />
                )}
                {running && !hasStreamingMessage && (
                  <div className="flex items-center gap-2 px-1">
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '0ms' }} />
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '120ms' }} />
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '240ms' }} />
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>
            <PromptComposer
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              disabled={running}
              inputDisabled={running}
              onAttach={handleAttach}
              projectPath={project?.path}
              attachments={
                <IssueAttachmentPreview
                  attachments={attachments}
                  notice={attachmentNotice}
                  onRemove={handleRemoveAttachment}
                />
              }
              placeholder={running ? 'Agent is responding...' : `Message agent about "${issue.title}"...`}
              className="pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] pr-8 lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10"
              showTopBorder={false}
              controls={running ? (
                <button onClick={handleCancel} className="pressable flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
                  <StopCircle className="size-3.5" /> Stop
                </button>
              ) : undefined}
            />
          </div>
        </main>
        <aside className="hidden w-72 shrink-0 border-l bg-muted/30 lg:block">
          <PropertyPanel className="flex-1">
            <PropertyField label="Project">
              <ProjectPicker
                projects={projects}
                value={selectedProject}
                fallbackName={project?.name ?? 'Unknown project'}
                onChange={(nextProject) => { void moveIssueToProject(nextProject) }}
              />
            </PropertyField>
            <PropertyField label="Status">
              <StatusPicker value={issue.status} onChange={(status) => patchIssue({ status })} />
            </PropertyField>
            <PropertyField label="Priority">
              <PriorityPicker value={issue.priority} onChange={(priority) => patchIssue({ priority })} />
            </PropertyField>
            <PropertyField label="Labels">
              <EditableLabels labels={issue.labels} allLabels={allLabels} onChange={(labels) => patchIssue({ labels })} />
            </PropertyField>
          </PropertyPanel>
        </aside>
      </div>
    </div>
  )
}

function IssueAttachmentPreview({
  attachments,
  notice,
  onRemove,
}: {
  attachments: ChatAttachment[]
  notice: string
  onRemove: (path: string) => void
}) {
  if (attachments.length === 0 && !notice) return null

  return (
    <div className="flex flex-col gap-2">
      {attachments.length > 0 && (
        <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
          {attachments.map((attachment) => (
            <div key={attachment.path} className="group flex max-w-56 items-center gap-2 rounded-md border bg-background/70 p-1.5 text-xs">
              <AttachmentPreviewImage
                attachment={attachment}
                className="size-8 rounded object-cover"
                fallbackClassName="size-8 rounded bg-muted"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{attachment.name}</div>
                <div className="text-[11px] text-muted-foreground">{formatBytes(attachment.size)}</div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(attachment.path)}
                className="pressable rounded p-0.5 text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {notice && <div className="text-xs text-muted-foreground">{notice}</div>}
    </div>
  )
}

function AgentRunStatusBadge({ status }: { status: AgentRunStatus }) {
  const label = status === 'running' ? 'Running' : status === 'succeeded' ? 'Completed' : status === 'failed' ? 'Failed' : 'Idle'
  const Icon = status === 'running' ? LoaderCircle : status === 'succeeded' ? CheckCircle : status === 'failed' ? X : Circle

  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
        status === 'running' && 'border-primary/35 bg-primary/10 text-primary',
        status === 'succeeded' && 'border-border bg-muted/45 text-foreground',
        status === 'failed' && 'border-destructive/30 bg-destructive/10 text-destructive',
        status === 'idle' && 'border-border bg-background text-muted-foreground',
      )}
    >
      <Icon className={cn('size-3.5', status === 'running' && 'animate-spin')} />
      {label}
    </span>
  )
}

function normalizeIssue(issue: Pick<Issue, 'id' | 'title'> & {
  status?: string
  priority?: string
  labels?: string[]
  detail?: string
  attributes?: Record<string, string>
}): Issue {
  return {
    id: issue.id,
    title: issue.title,
    status: normalizeIssueStatus(issue.status),
    priority: normalizeIssuePriority(issue.priority),
    labels: issue.labels ?? [],
    detail: issue.detail ?? '',
    attributes: issue.attributes ?? {},
  }
}

function uniqueLabels(issues: Issue[]) {
  return Array.from(new Set(issues.flatMap((issue) => issue.labels))).sort((a, b) => a.localeCompare(b))
}

function shouldAutoExecuteIssue(previous: Issue | undefined, patch: Partial<Issue>) {
  return previous?.status !== 'todo' && patch.status === 'todo'
}

function inferAgentRunStatus(logs: ChatMessage[]): AgentRunStatus {
  const lastAgentLog = [...logs].reverse().find((entry) => entry.role === 'assistant')
  if (!lastAgentLog) return 'idle'
  if (lastAgentLog.content.startsWith('Agent run failed')) return 'failed'
  if (lastAgentLog.content.startsWith('Agent run started')) return 'idle'
  return 'succeeded'
}

function normalizeIssueStatus(status: string | undefined): IssueStatus {
  return ISSUE_STATUSES.includes(status as IssueStatus) ? status as IssueStatus : 'backlog'
}

function normalizeIssuePriority(priority: string | undefined): IssuePriority {
  return ISSUE_PRIORITIES.includes(priority as IssuePriority) ? priority as IssuePriority : 'none'
}

function readAgentSettings(config: Record<string, unknown> | undefined) {
  const agent = isRecord(config?.agent) ? config.agent : {}
  return {
    agentKind: typeof agent.kind === 'string' && agent.kind ? agent.kind : 'codex',
    model: typeof agent.model === 'string' ? agent.model : '',
    thinking: typeof agent.thinking === 'string' && agent.thinking ? agent.thinking : 'medium',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueSessionId(issueId: string) {
  return issueId.startsWith('issue-') ? issueId : `issue-${issueId}`
}

function buildIssuePrompt(issue: Issue, logs: ChatMessage[], message: string) {
  const previous = logs.slice(-8).map((entry) => `${entry.role === 'user' ? 'User' : 'Agent'}: ${entry.content}`).join('\n\n')
  return [
    `Issue: ${issue.title}`,
    issue.detail ? `Issue detail:\n${issue.detail}` : '',
    previous ? `Recent issue conversation:\n${previous}` : '',
    `User message:\n${message}`,
  ].filter(Boolean).join('\n\n')
}
