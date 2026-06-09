import { MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { electronClient } from '@/shared/api/electron-client'
import {
  Settings,
  Plus,
  ChevronDown,
  Folder,
  FolderOpen,
  PanelLeftClose,
  X,
  Trash2,
  ListChecks,
} from 'lucide-react'
import { basename, cn } from '@/lib/utils'
import { toggleMaximize } from '@/lib/window'
import { useProjects } from '@/components/project/ProjectProvider'
import { useWorkspaces } from '@/components/workspace/WorkspaceProvider'
import type { ProjectConfig } from '@/data/project'

const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 400
const SIDEBAR_DEFAULT_WIDTH = 192
const SIDEBAR_WIDTH_KEY = 'pai.sidebarWidth'

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed
      }
    }
  } catch { /* ignore */ }
  return SIDEBAR_DEFAULT_WIDTH
}

function saveSidebarWidth(width: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
}

export function Sidebar({
  isCollapsed,
  onToggleCollapsed,
}: {
  isCollapsed: boolean
  onToggleCollapsed: () => void
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [isImporting, setIsImporting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceLocation, setWorkspaceLocation] = useState('')
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false)
  const [projectMenu, setProjectMenu] = useState<{ project: ProjectConfig; x: number; y: number } | null>(null)
  const [width, setWidth] = useState(loadSidebarWidth)
  const menuRef = useRef<HTMLDivElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { projects, importExistingProject, removeProject } = useProjects()
  const { workspaces, activeWorkspace, setActiveWorkspace, createWorkspaceAt, openWorkspace, removeWorkspace } = useWorkspaces()

  useEffect(() => {
    function handleClickOutside(e: globalThis.MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Sidebar resize
  useEffect(() => {
    function handleMouseMove(e: globalThis.MouseEvent) {
      if (!dragging.current || isCollapsed) return
      setWidth((prev) => {
        const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX))
        if (next !== prev) saveSidebarWidth(next)
        return next
      })
    }

    function handleMouseUp() {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isCollapsed])

  const handleResizeStart = useCallback(() => {
    if (isCollapsed) return
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [isCollapsed])

  const handleToggleCollapsed = useCallback(() => {
    if (!isCollapsed) {
      setMenuOpen(false)
      setProjectMenu(null)
    }
    onToggleCollapsed()
  }, [isCollapsed, onToggleCollapsed])

  const handleImportProject = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setIsImporting(true)
    try {
      const importedProject = await importExistingProject()
      if (importedProject) {
        setProjectsExpanded(true)
        navigate(`/project/${importedProject.slug}/overview`)
      }
    } finally {
      setIsImporting(false)
    }
  }

  const handleAddWorkspace = useCallback(async () => {
    setMenuOpen(false)
    setCreateWorkspaceOpen(true)
  }, [])

  const handleChooseWorkspaceLocation = useCallback(async () => {
    const folderPath = await electronClient?.openFolder()
    if (!folderPath) return
    setWorkspaceLocation(folderPath)
    if (!workspaceName.trim()) setWorkspaceName(basename(folderPath))
  }, [workspaceName])

  const handleCreateWorkspaceSubmit = useCallback(async () => {
    if (!workspaceName.trim() || !workspaceLocation) return
    setIsCreatingWorkspace(true)
    try {
      await createWorkspaceAt(workspaceName.trim(), workspaceLocation)
      setCreateWorkspaceOpen(false)
    } finally {
      setIsCreatingWorkspace(false)
    }
  }, [createWorkspaceAt, workspaceLocation, workspaceName])

  const handleOpenWorkspace = useCallback(async () => {
    setMenuOpen(false)
    await openWorkspace()
  }, [openWorkspace])

  const handleRemoveWorkspace = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      removeWorkspace(id)
      setMenuOpen(false)
    },
    [removeWorkspace],
  )

  const handleSwitchWorkspace = useCallback(
    (id: string) => {
      const workspace = workspaces.find((w) => w.id === id)
      if (workspace) setActiveWorkspace(workspace)
      setMenuOpen(false)
    },
    [workspaces, setActiveWorkspace],
  )

  const toggleMenu = useCallback(() => {
    setMenuOpen((v) => !v)
  }, [])

  const handleRemoveProject = useCallback(async (project: ProjectConfig) => {
    const updated = await removeProject(project)
    setProjectMenu(null)
    if (!location.pathname.startsWith(`/project/${project.slug}`)) return

    const nextProject = updated[0]
    navigate(nextProject ? `/project/${nextProject.slug}/overview` : '/settings')
  }, [location.pathname, navigate, removeProject])

  if (isCollapsed) return null

  return (
    <aside
      className="app-sidebar relative flex h-full select-none flex-col border-r transition-[width] duration-150 [transition-timing-function:var(--ease-out)]"
      style={{ width }}
    >
      {/* Draggable title bar */}
      <div
        className="relative flex h-[88px] flex-col border-b bg-transparent"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        onDoubleClick={toggleMaximize}
      >
        <div className={cn('flex h-8 items-center', !isCollapsed && 'justify-end px-2')}>
          {!isCollapsed && (
            <button
              type="button"
              onClick={handleToggleCollapsed}
              className="no-drag pressable flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>
        <div className={cn('flex min-h-0 flex-1 items-center', isCollapsed ? 'justify-center px-2' : 'gap-1 px-3')} ref={menuRef}>
          <button
            className={cn(
              'no-drag pressable flex h-8 min-w-0 items-center gap-2 rounded-md text-[20px] font-semibold leading-7 hover:bg-background/70',
              isCollapsed ? 'w-8 justify-center px-0' : 'w-full px-2',
            )}
            onClick={toggleMenu}
            onDoubleClick={(event) => event.stopPropagation()}
            title={activeWorkspace?.name ?? 'Workspace'}
          >
            {isCollapsed ? (
              <Folder className="size-4 shrink-0" />
            ) : (
              <>
                <span className="truncate">{activeWorkspace?.name ?? ''}</span>
                <ChevronDown className={cn('size-4 shrink-0 transition-transform', menuOpen && 'rotate-180')} />
              </>
            )}
          </button>
          {menuOpen && (
            <div className={cn('popover-enter no-drag absolute top-full z-50 mt-1 w-56 rounded-md border bg-popover p-1 shadow-xl shadow-black/10', isCollapsed ? 'left-2' : 'left-3')}>
              <div className="max-h-48 overflow-y-auto">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => handleSwitchWorkspace(workspace.id)}
                  className={cn(
                    'group pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    workspace.id === activeWorkspace?.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'hover:bg-accent/50 hover:text-accent-foreground',
                  )}
                >
                  <Folder className="size-3.5 shrink-0" />
                  <span className="flex-1 truncate">{workspace.name}</span>
                  <button
                    onClick={(e) => handleRemoveWorkspace(e, workspace.id)}
                    className="pressable ml-auto shrink-0 rounded-sm p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                    aria-label={`Remove ${workspace.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </button>
              ))}
              </div>
              <Separator className="my-1" />
              <button
                onClick={handleAddWorkspace}
                className="pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent/50 hover:text-accent-foreground"
              >
                <Plus className="size-3.5 shrink-0" />
                <span>Create Workspace</span>
              </button>
              <button
                onClick={handleOpenWorkspace}
                className="pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent/50 hover:text-accent-foreground"
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span>Open Workspace</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className={cn('flex flex-col gap-2 py-3', isCollapsed ? 'px-2' : 'px-3')}>
          {!isCollapsed && <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Favorite</div>}
        </div>

        <div className={cn('flex flex-col gap-1 py-3', isCollapsed ? 'px-2' : 'px-3')}>
          <SidebarItem to="/issues" icon={ListChecks} label="All Issues" collapsed={isCollapsed} />
        </div>

        <div className={cn('flex flex-col gap-1 py-3', isCollapsed ? 'px-2' : 'px-3')}>
          {isCollapsed ? (
            <button
              type="button"
              className="pressable flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-40"
              aria-label="Import existing project"
              title="Import project"
              disabled={isImporting}
              onClick={handleImportProject}
            >
              <Plus className="size-4" />
            </button>
          ) : (
            <div className="flex w-full items-center gap-1">
              <button
                type="button"
                onClick={() => setProjectsExpanded(!projectsExpanded)}
                className="pressable flex min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
                aria-expanded={projectsExpanded}
              >
                <ChevronDown
                  className={cn(
                    'mr-1 size-3 transition-transform',
                    !projectsExpanded && '-rotate-90',
                  )}
                />
                Projects
              </button>
              <button
                type="button"
                className="pressable flex size-5 items-center justify-center rounded text-muted-foreground opacity-70 hover:bg-background/70 hover:text-foreground hover:opacity-100 disabled:opacity-40"
                aria-label="Import existing project"
                disabled={isImporting}
                onClick={handleImportProject}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          )}

          {(projectsExpanded || isCollapsed) && (
            <div className="flex flex-col gap-0.5">
              {projects.map((project) => (
                <ProjectSidebarItem
                  key={project.slug}
                  project={project}
                  pathname={location.pathname}
                  collapsed={isCollapsed}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setProjectMenu({ project, x: event.clientX, y: event.clientY })
                  }}
                />
              ))}
            </div>
          )}
        </div>

      </ScrollArea>

      <div className={cn('border-t', isCollapsed ? 'p-2' : 'p-3')}>
        <SidebarItem to="/settings" icon={Settings} label="Settings" collapsed={isCollapsed} />
      </div>

      {/* Resize handle */}
      {!isCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="no-drag absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/25"
        />
      )}

      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="popover-enter fixed z-50 w-40 rounded-md border bg-popover p-1 shadow-xl shadow-black/10"
          style={{ left: projectMenu.x, top: projectMenu.y }}
        >
          <button
            onClick={() => handleRemoveProject(projectMenu.project)}
            className="pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
            <span>Remove Project</span>
          </button>
        </div>
      )}

      {createWorkspaceOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-6 backdrop-blur-sm">
          <div className="modal-enter w-full max-w-md rounded-lg border bg-background p-5 shadow-xl shadow-black/[0.08]">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create Workspace</h2>
              <button
                type="button"
                onClick={() => setCreateWorkspaceOpen(false)}
                className="pressable rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Workspace Name</span>
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="My Workspace"
                  autoFocus
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Location</span>
                <div className="flex gap-2">
                  <Input value={workspaceLocation} readOnly placeholder="Choose a folder..." className="min-w-0 flex-1 font-mono text-xs" />
                  <Button type="button" variant="outline" onClick={handleChooseWorkspaceLocation}>
                    Choose
                  </Button>
                </div>
              </label>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setCreateWorkspaceOpen(false)} disabled={isCreatingWorkspace}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleCreateWorkspaceSubmit}
                  disabled={isCreatingWorkspace || !workspaceName.trim() || !workspaceLocation}
                >
                  {isCreatingWorkspace ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

function ProjectSidebarItem({
  project,
  pathname,
  collapsed,
  onContextMenu,
}: {
  project: ProjectConfig
  pathname: string
  collapsed?: boolean
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const isProjectActive = pathname === `/project/${project.slug}` || pathname.startsWith(`/project/${project.slug}/`)

  return (
    <div onContextMenu={onContextMenu}>
      <NavLink
        to={`/project/${project.slug}/overview`}
        className={() =>
          cn(
            'pressable flex min-w-0 flex-1 items-center rounded-md text-sm',
            collapsed ? 'size-10 justify-center px-0 py-0' : 'gap-2 px-2 py-1.5',
            isProjectActive
              ? 'bg-[hsl(var(--sidebar-active))] text-foreground shadow-sm ring-1 ring-border/60'
              : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
          )
        }
        title={project.name}
      >
        <Folder className="size-4 shrink-0 opacity-80" />
        {!collapsed && <span className="truncate">{project.name}</span>}
      </NavLink>
    </div>
  )
}

function SidebarItem({
  to,
  icon: Icon,
  label,
  collapsed,
}: {
  to: string
  icon: React.ElementType
  label: string
  collapsed?: boolean
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'pressable flex items-center rounded-md text-sm',
          collapsed ? 'size-10 justify-center px-0 py-0' : 'gap-2 px-2 py-1.5',
          isActive
            ? 'bg-[hsl(var(--sidebar-active))] text-foreground shadow-sm ring-1 ring-border/60'
            : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
        )
      }
      title={label}
    >
      <Icon className="size-4 shrink-0 opacity-80" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  )
}
