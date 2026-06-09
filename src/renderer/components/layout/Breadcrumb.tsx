import { useLocation, useParams } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { ChevronRight, Folder, FolderOpen, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaces } from '@/components/workspace/WorkspaceProvider'
import { useProjects } from '@/components/project/ProjectProvider'
import { toggleMaximize } from '@/lib/window'

export function Breadcrumb({
  sidebarCollapsed = false,
  onToggleSidebar,
}: {
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}) {
  const { name, issueId } = useParams()
  const location = useLocation()
  const { activeWorkspace } = useWorkspaces()
  const { getProject } = useProjects()

  const project = name ? getProject(name) : null

  // Determine current view label
  const pathSegments = location.pathname.split('/').filter(Boolean)
  const viewSegment = pathSegments[pathSegments.length - 1]
  let viewLabel = ''
  if (viewSegment === 'settings') viewLabel = 'Settings'
  else if (viewSegment === 'overview') viewLabel = 'Overview'
  else if (viewSegment === 'chat') viewLabel = 'Chat'
  else if (viewSegment === 'issues') viewLabel = issueId ? `Issues / ${issueId}` : 'Issues'
  else viewLabel = ''

  const items = viewSegment === 'settings'
    ? [
        { label: activeWorkspace?.name ?? '', icon: FolderOpen },
        { label: viewLabel },
      ].filter((item) => item.label)
    : [
        { label: activeWorkspace?.name ?? '', icon: FolderOpen },
        ...(project ? [{ label: project.name, icon: Folder }] : []),
        { label: viewLabel },
      ].filter((item) => item.label)

  if (items.length === 0) return null

  return (
    <nav
      className="flex h-9 shrink-0 items-center gap-1 border-b bg-background/80 pr-4 text-xs backdrop-blur"
      style={{ WebkitAppRegion: 'drag', paddingLeft: `calc(var(--traffic-light-safe-width, 0px) + 1rem)` } as CSSProperties}
      onDoubleClick={toggleMaximize}
    >
      {sidebarCollapsed && (
        <button
          type="button"
          onClick={onToggleSidebar}
          className="no-drag pressable mr-3 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      )}
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 text-muted-foreground/40" />}
          {item.icon && <item.icon className="size-3 text-muted-foreground" />}
          <span className={cn('font-medium', i === items.length - 1 ? 'text-foreground' : 'text-muted-foreground')}>
            {item.label}
          </span>
        </span>
      ))}
    </nav>
  )
}
