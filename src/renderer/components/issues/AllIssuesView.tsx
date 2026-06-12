import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Circle, Columns3, List } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useProjects } from '@/components/project/ProjectProvider'
import { EditableLabels, PRIORITY_OPTIONS, PriorityPicker, STATUS_OPTIONS, StatusDot, StatusPicker } from '@/components/issues/IssueControls'
import { Issue, IssuePriority, IssueStatus } from '@/data/project'
import { cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'

type IssueViewMode = 'list' | 'board'

const ISSUE_VIEW_MODE_KEY = 'pai.issue.viewMode'

interface ProjectIssue {
  issue: Issue
  projectSlug: string
  projectName: string
  projectPath: string
}

export function AllIssuesView() {
  const { projects } = useProjects()
  const [issues, setIssues] = useState<ProjectIssue[]>([])
  const [viewMode, setViewMode] = useState<IssueViewMode>(() => {
    const stored = localStorage.getItem(ISSUE_VIEW_MODE_KEY)
    return stored === 'board' ? 'board' : 'list'
  })

  useEffect(() => {
    localStorage.setItem(ISSUE_VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  useEffect(() => {
    let cancelled = false
    const projectPaths = new Set(projects.map((project) => project.path).filter((path): path is string => Boolean(path)))
    async function load() {
      const results: ProjectIssue[] = []
      for (const project of projects) {
        if (!project.path) continue
        const projectIssues = await electronClient?.readIssues(project.path)
        if (cancelled) return
        if (projectIssues) {
          for (const issue of projectIssues) {
            results.push({
              issue: issue as Issue,
              projectSlug: project.slug,
              projectName: project.name,
              projectPath: project.path,
            })
          }
        }
      }
      if (!cancelled) setIssues(results.map((pi) => ({ ...pi, issue: normalizeIssue(pi.issue) })))
    }
    load()
    const unsubscribe = electronClient?.onProjectIssuesChanged((data) => {
      if (projectPaths.has(data.projectPath)) void load()
    })
    const watchUnsubscribers: Array<() => void> = []
    for (const projectPath of projectPaths) {
      void electronClient?.watchProject(projectPath, (data) => {
        if (projectPaths.has(data.projectPath)) void load()
      }).then((cleanup) => {
        if (cancelled) cleanup()
        else watchUnsubscribers.push(cleanup)
      })
    }
    return () => {
      cancelled = true
      unsubscribe?.()
      watchUnsubscribers.forEach((cleanup) => cleanup())
    }
  }, [projects])

  const handleIssueChange = useCallback(async (projectIssue: ProjectIssue, patch: Partial<Issue>) => {
    setIssues((current) => current.map((item) => (
      item.projectPath === projectIssue.projectPath && item.issue.id === projectIssue.issue.id
        ? { ...item, issue: normalizeIssue({ ...item.issue, ...patch }) }
        : item
    )))

    const project = projects.find((item) => item.path === projectIssue.projectPath)
    if (!project?.path) return

    const loadedIssues = await electronClient?.readIssues(project.path)
    if (!loadedIssues) return

    const updatedIssues = loadedIssues.map((issue) => (
      issue.id === projectIssue.issue.id ? normalizeIssue({ ...issue, ...patch }) : normalizeIssue(issue)
    ))
    const savedIssues = await electronClient?.writeIssues(project.path, updatedIssues)
    if (!savedIssues) return

    setIssues((current) => {
      const withoutProject = current.filter((item) => item.projectPath !== project.path)
      const projectIssues = savedIssues.map((issue) => ({
        issue: normalizeIssue(issue),
        projectSlug: project.slug,
        projectName: project.name,
        projectPath: project.path!,
      }))
      return [...withoutProject, ...projectIssues].sort(compareProjectIssues)
    })
  }, [projects])

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b bg-background/80 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7 backdrop-blur" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h1 className="text-sm font-semibold">All Issues</h1>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
        </div>
      </div>

      {viewMode === 'list' ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="content-enter mx-auto flex w-full max-w-6xl flex-col py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
            <GlobalIssueList issues={issues} onIssueChange={handleIssueChange} />
            {issues.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-20 text-center">
                <Circle className="size-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No issues yet</p>
                <p className="text-xs text-muted-foreground">Issues from your projects will appear here.</p>
              </div>
            )}
          </div>
        </ScrollArea>
      ) : issues.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7 text-center">
          <Circle className="size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">No issues yet</p>
          <p className="text-xs text-muted-foreground">Issues from your projects will appear here.</p>
        </div>
      ) : (
        <div className="content-enter flex min-h-0 flex-1 overflow-x-auto py-5 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
          <GlobalIssueBoard issues={issues} onIssueChange={handleIssueChange} />
        </div>
      )}
    </div>
  )
}

function GlobalIssueList({
  issues,
  onIssueChange,
}: {
  issues: ProjectIssue[]
  onIssueChange: (projectIssue: ProjectIssue, patch: Partial<Issue>) => void
}) {
  if (issues.length === 0) return null
  const allLabels = uniqueLabels(issues.map((item) => item.issue))

  return (
    <>
      <div className="grid grid-cols-[minmax(260px,1fr)_140px_220px_150px_130px] border-b bg-background/70 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>Title</div>
        <div>Project</div>
        <div>Labels</div>
        <div>Status</div>
        <div>Priority</div>
      </div>
      <div className="divide-y rounded-b-lg border-x border-b bg-[hsl(var(--surface-raised))]">
        {issues.map((pi) => (
          <GlobalIssueRow key={`${pi.projectSlug}:${pi.issue.id}`} projectIssue={pi} allLabels={allLabels} onIssueChange={onIssueChange} />
        ))}
      </div>
    </>
  )
}

function GlobalIssueRow({
  projectIssue,
  allLabels,
  onIssueChange,
}: {
  projectIssue: ProjectIssue
  allLabels: string[]
  onIssueChange: (projectIssue: ProjectIssue, patch: Partial<Issue>) => void
}) {
  const { issue, projectSlug, projectName } = projectIssue

  return (
    <div className="grid grid-cols-[minmax(260px,1fr)_140px_220px_150px_130px] items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/35">
      <Link to={`/project/${projectSlug}/issues/${issue.id}`} className="min-w-0 truncate font-medium hover:text-primary">
        {issue.title}
      </Link>
      <span className="truncate text-xs text-muted-foreground">{projectName}</span>
      <EditableLabels labels={issue.labels} allLabels={allLabels} onChange={(labels) => onIssueChange(projectIssue, { labels })} />
      <StatusPicker value={issue.status} onChange={(status) => onIssueChange(projectIssue, { status })} />
      <PriorityPicker value={issue.priority} onChange={(priority) => onIssueChange(projectIssue, { priority })} />
    </div>
  )
}

function GlobalIssueBoard({
  issues,
  onIssueChange,
}: {
  issues: ProjectIssue[]
  onIssueChange: (projectIssue: ProjectIssue, patch: Partial<Issue>) => void
}) {
  const allLabels = uniqueLabels(issues.map((item) => item.issue))
  const [draggedIssueKey, setDraggedIssueKey] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<IssueStatus | null>(null)

  if (issues.length === 0) return null

  const handleDrop = (event: React.DragEvent, status: IssueStatus) => {
    event.preventDefault()
    const issueKey = event.dataTransfer.getData('text/plain') || draggedIssueKey
    setDraggedIssueKey(null)
    setDragOverStatus(null)

    const projectIssue = issues.find((item) => projectIssueKey(item) === issueKey)
    if (!projectIssue || projectIssue.issue.status === status) return
    onIssueChange(projectIssue, { status })
  }

  return (
    <div className="grid h-full w-full min-w-[920px] grid-cols-4 gap-3">
      {STATUS_OPTIONS.map((status) => {
        const statusIssues = issues.filter((pi) => pi.issue.status === status.id)
        const isDropTarget = dragOverStatus === status.id

        return (
          <section
            key={status.id}
            className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/25 shadow-sm shadow-black/[0.02] transition-[background-color,border-color,box-shadow] duration-150 [transition-timing-function:var(--ease-out)]', isDropTarget && 'border-primary/50 bg-primary/5 shadow-md')}
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
              {statusIssues.map((pi) => (
                <GlobalIssueCard
                  key={`${pi.projectSlug}:${pi.issue.id}`}
                  projectIssue={pi}
                  allLabels={allLabels}
                  dragging={draggedIssueKey === projectIssueKey(pi)}
                  onIssueChange={onIssueChange}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', projectIssueKey(pi))
                    setDraggedIssueKey(projectIssueKey(pi))
                  }}
                  onDragEnd={() => {
                    setDraggedIssueKey(null)
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

function GlobalIssueCard({
  projectIssue,
  allLabels,
  dragging,
  onIssueChange,
  onDragStart,
  onDragEnd,
}: {
  projectIssue: ProjectIssue
  allLabels: string[]
  dragging: boolean
  onIssueChange: (projectIssue: ProjectIssue, patch: Partial<Issue>) => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const { issue, projectSlug, projectName } = projectIssue
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
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <Link to={`/project/${projectSlug}/issues/${issue.id}`} className="block truncate text-sm font-medium leading-5 hover:text-primary">
        {issue.title}
      </Link>
      <div className="mt-1 truncate text-xs text-muted-foreground">{projectName}</div>
      <div className="mt-3 flex items-center gap-3">
        <EditableLabels labels={issue.labels} allLabels={allLabels} onChange={(labels) => onIssueChange(projectIssue, { labels })} compact />
        <PriorityPicker value={issue.priority} onChange={(priority) => onIssueChange(projectIssue, { priority })} />
      </div>
    </article>
  )
}

function setCardDragImage(event: React.DragEvent, card: HTMLElement) {
  const rect = card.getBoundingClientRect()
  event.dataTransfer.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top)
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

function normalizeIssueStatus(status: string | undefined): IssueStatus {
  return STATUS_OPTIONS.some((option) => option.id === status) ? status as IssueStatus : 'backlog'
}

function normalizeIssuePriority(priority: string | undefined): IssuePriority {
  return PRIORITY_OPTIONS.some((option) => option.id === priority) ? priority as IssuePriority : 'none'
}

function uniqueLabels(issues: Issue[]) {
  return Array.from(new Set(issues.flatMap((issue) => issue.labels))).sort((a, b) => a.localeCompare(b))
}

function projectIssueKey(projectIssue: ProjectIssue) {
  return `${projectIssue.projectPath}:${projectIssue.issue.id}`
}

function compareProjectIssues(a: ProjectIssue, b: ProjectIssue) {
  const project = a.projectName.localeCompare(b.projectName)
  if (project !== 0) return project
  return a.issue.title.localeCompare(b.issue.title)
}
