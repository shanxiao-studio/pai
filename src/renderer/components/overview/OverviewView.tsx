import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Bot, Check, Github, Settings, X } from 'lucide-react'
import { siAnthropic, siClaude, siClaudecode, siPi } from 'simple-icons'
import { EditableLabels, StatusPicker } from '@/components/issues/IssueControls'
import { PropertyField, PropertyPanel } from '@/components/project/PropertyPanel'
import { ProjectTabs } from '@/components/project/ProjectTabs'
import { useProjects } from '@/components/project/ProjectProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { IssueStatus, ProjectConfig } from '@/data/project'
import { cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'

const DEFAULT_MODEL: Record<string, string> = {
  codex: '',
  pi: '',
  claude: '',
}

const DEFAULT_THINKING: Record<string, string> = {
  codex: 'medium',
  pi: 'medium',
  claude: 'medium',
}

interface AgentInfo {
  kind: string
  command: string
  version: string | null
  available: boolean
  error?: string
}

export function OverviewView() {
  const { name } = useParams()
  const { getProject, updateProject } = useProjects()
  const project = getProject(name)

  if (!project) {
    return (
      <div className="flex h-full flex-col bg-background">
        <ProjectTabs />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Import a project to get started.</p>
        </div>
      </div>
    )
  }

  return <ProjectOverview key={project.path ?? project.slug} project={project} updateProject={updateProject} />
}

function ProjectOverview({ project, updateProject }: { project: ProjectConfig; updateProject: (project: ProjectConfig, patch: Partial<ProjectConfig>) => void }) {
  const [projectName, setProjectName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [projectStatus, setProjectStatus] = useState(project.status)
  const [githubLink, setGithubLink] = useState(project.githubLink)
  const [repoDialogOpen, setRepoDialogOpen] = useState(false)
  const [repoDraft, setRepoDraft] = useState(project.githubLink)
  const [repoError, setRepoError] = useState('')
  const [labels, setLabels] = useState(project.labels.join(', '))
  const [agentsMd, setAgentsMd] = useState(project.agentsMd)

  // Agent config
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentKind, setAgentKind] = useState('')
  const [loaded, setLoaded] = useState(false)
  const overviewSaveTimer = useRef<number | null>(null)
  const lastOverviewSnapshot = useRef('')
  const lastAgentKind = useRef('')

  useEffect(() => {
    setProjectName(project.name)
    setDescription(project.description)
    setProjectStatus(project.status)
    setGithubLink(project.githubLink)
    setRepoDraft(project.githubLink)
    setRepoError('')
    setRepoDialogOpen(false)
    setLabels(project.labels.join(', '))
    setAgentsMd(project.agentsMd)
    lastOverviewSnapshot.current = JSON.stringify({
      name: project.name,
      description: project.description,
      status: project.status,
      githubLink: project.githubLink,
      labels: project.labels,
      agentsMd: project.agentsMd,
    })
  }, [project])

  // Detect agents + load saved config
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoaded(false)
      setAgents([])
      let savedKind = ''
      if (project.path) {
        const saved = await electronClient?.readAgentConfig(project.path)
        if (cancelled) return
        const kind = readAgentKind(saved)
        if (kind) {
          savedKind = kind
          setAgentKind(savedKind)
          lastAgentKind.current = savedKind
        }
      }
      setLoaded(true)

      void electronClient?.detectAgents().then((detected) => {
        if (cancelled || !detected) return
        setAgents(detected)

        if (!savedKind) {
          const first = detected.find((a) => a.available)
          if (first) setAgentKind(first.kind)
        }
      })
    }

    init()
    return () => {
      cancelled = true
    }
  }, [project.path])

  useEffect(() => {
    if (!project.path) return

    const projectPath = project.path
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    electronClient?.watchProject(projectPath, (data) => {
      if (data.projectPath !== projectPath) return
      void (async () => {
        const saved = await electronClient?.readAgentConfig(projectPath)
        if (cancelled) return

        const kind = readAgentKind(saved)
        if (kind) {
          const savedKind = kind
          setAgentKind(savedKind)
          lastAgentKind.current = savedKind
        }
      })()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [project.path])

  useEffect(() => {
    if (!project.path) return

    const snapshot = JSON.stringify({
      name: projectName,
      description,
      status: projectStatus,
      githubLink,
      labels: parseLabels(labels),
      agentsMd,
    })
    if (snapshot === lastOverviewSnapshot.current) return

    if (overviewSaveTimer.current) window.clearTimeout(overviewSaveTimer.current)
    overviewSaveTimer.current = window.setTimeout(async () => {
      const updatedLabels = parseLabels(labels)
      await electronClient?.writeOverviewConfig(project.path!, {
        name: projectName,
        description,
        status: projectStatus,
        githubLink,
        labels: updatedLabels,
        agentsMd,
      })
      updateProject(project, {
        name: projectName,
        description,
        status: projectStatus,
        githubLink,
        labels: updatedLabels,
        agentsMd,
      })
      lastOverviewSnapshot.current = snapshot
    }, 500)

    return () => {
      if (overviewSaveTimer.current) window.clearTimeout(overviewSaveTimer.current)
    }
  }, [project, projectName, description, projectStatus, githubLink, labels, agentsMd, updateProject])

  useEffect(() => {
    if (!project.path || !loaded || !agentKind || lastAgentKind.current === agentKind) return

    lastAgentKind.current = agentKind
    void electronClient?.writeAgentConfig(project.path, {
      kind: agentKind,
      model: DEFAULT_MODEL[agentKind] ?? '',
      thinking: DEFAULT_THINKING[agentKind] ?? 'medium',
    })
  }, [project.path, loaded, agentKind])

  const agentOptions = agentKind && !agents.some((agent) => agent.kind === agentKind)
    ? [{ kind: agentKind, command: agentKind, version: null, available: true }, ...agents]
    : agents
  const activeAgent = agentOptions.find((agent) => agent.kind === agentKind)
  const projectLabels = parseLabels(labels)
  const repositoryLabel = formatRepositoryLabel(githubLink)
  const repositoryUrl = formatRepositoryUrl(githubLink)

  const openRepositoryDialog = () => {
    setRepoDraft(githubLink)
    setRepoError('')
    setRepoDialogOpen(true)
  }

  const openRepository = () => {
    if (!repositoryUrl) {
      openRepositoryDialog()
      return
    }

    void electronClient?.openExternalUrl(repositoryUrl)
  }

  const saveRepository = () => {
    const normalized = repoDraft.trim()
    if (!isGithubRepositoryUrl(normalized)) {
      setRepoError('Enter a GitHub repository URL like https://github.com/org/repo.')
      return
    }

    setGithubLink(normalized)
    setRepoDialogOpen(false)
    setRepoError('')
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectTabs />

      <div className="flex min-h-0 flex-1 bg-background/65">
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div className="content-enter mr-auto flex min-h-full w-full max-w-6xl flex-col gap-8 py-7 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
            <header className="flex flex-col gap-2 border-b pb-6">
              <div className="min-w-0">
                <Input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  aria-label="Project name"
                  className="h-auto border-0 bg-transparent px-0 py-0 text-[34px] font-semibold leading-tight tracking-tight shadow-none focus-visible:ring-0"
                />
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  aria-label="Project description"
                  placeholder="Add a project description..."
                  className="h-auto border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                />
              </div>
            </header>

            <section className="flex min-w-0 flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">AGENTS.md</h2>
              </div>
              <div className="rounded-lg border bg-[hsl(var(--surface-raised))] shadow-sm shadow-black/[0.03]">
                <div className="flex h-9 items-center justify-between border-b px-3">
                  <span className="font-mono text-[11px] font-medium text-muted-foreground">/AGENTS.md</span>
                </div>
                <Textarea
                  value={agentsMd}
                  onChange={(event) => setAgentsMd(event.target.value)}
                  placeholder="# AGENTS Instruction&#10;&#10;Write project-level agent guidance here."
                  aria-label="AGENTS.md"
                  className="min-h-[520px] resize-y rounded-t-none border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 shadow-none focus-visible:ring-0"
                />
              </div>
            </section>
          </div>
        </main>

        <aside className="hidden w-72 shrink-0 border-l bg-muted/30 lg:block">
          <PropertyPanel>
            <PropertyField label="Agent">
              <AgentPicker
                value={agentKind}
                options={agentOptions}
                loaded={loaded}
                activeAgent={activeAgent}
                onChange={setAgentKind}
              />
            </PropertyField>
            <PropertyField label="Status">
              <StatusPicker value={projectStatus} onChange={setProjectStatus} />
            </PropertyField>
            <PropertyField label="Repository">
              <div className="group flex w-full min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={openRepository}
                  className="pressable flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-muted"
                  title={repositoryUrl || githubLink}
                >
                  <Github className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn('min-w-0 flex-1 truncate', repositoryLabel ? 'text-foreground' : 'text-muted-foreground')}>
                    {repositoryLabel || 'Set repository'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={openRepositoryDialog}
                  className="pressable flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                  aria-label="Edit repository"
                  title="Edit repository"
                >
                  <Settings className="size-3.5" />
                </button>
              </div>
            </PropertyField>
            <PropertyField label="Labels">
              <EditableLabels
                labels={projectLabels}
                allLabels={projectLabels}
                onChange={(nextLabels) => setLabels(nextLabels.join(', '))}
              />
            </PropertyField>
          </PropertyPanel>
        </aside>
      </div>

      {repoDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onMouseDown={() => setRepoDialogOpen(false)}>
          <form
            className="popover-enter w-full max-w-md rounded-lg border bg-popover p-4 shadow-xl shadow-black/15"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              saveRepository()
            }}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Repository</h2>
              </div>
              <button
                type="button"
                onClick={() => setRepoDialogOpen(false)}
                className="pressable flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close repository editor"
              >
                <X className="size-4" />
              </button>
            </div>
            <label className="grid gap-2">
              <span className="text-xs font-medium text-muted-foreground">GitHub URL</span>
              <Input
                value={repoDraft}
                onChange={(event) => {
                  setRepoDraft(event.target.value)
                  setRepoError('')
                }}
                placeholder="https://github.com/org/repo"
                aria-label="GitHub repository URL"
                autoFocus
              />
            </label>
            {repoError && <p className="mt-2 text-xs text-destructive">{repoError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRepoDialogOpen(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function formatRepositoryLabel(value: string) {
  const parsed = parseGithubRepository(value)
  return parsed ? `${parsed.owner}/${parsed.repo}` : value.trim()
}

function formatRepositoryUrl(value: string) {
  const parsed = parseGithubRepository(value)
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : ''
}

function isGithubRepositoryUrl(value: string) {
  return parseGithubRepository(value)?.kind === 'web'
}

function parseGithubRepository(value: string): { owner: string; repo: string; kind: 'web' | 'ssh' } | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) return null
    const repo = stripGitSuffix(parts[1])
    if (!parts[0] || !repo) return null
    return { owner: parts[0], repo, kind: 'web' }
  } catch {
    const match = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed)
    if (!match) return null
    const repo = stripGitSuffix(match[2])
    if (!match[1] || !repo) return null
    return { owner: match[1], repo, kind: 'ssh' }
  }
}

function stripGitSuffix(value: string) {
  return value.endsWith('.git') ? value.slice(0, -4) : value
}

function parseLabels(value: string) {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
}

function agentLabel(kind: string) {
  return { codex: 'Codex', pi: 'Pi', claude: 'Claude' }[kind] ?? kind
}

function AgentPicker({
  value,
  options,
  loaded,
  activeAgent,
  onChange,
}: {
  value: string
  options: AgentInfo[]
  loaded: boolean
  activeAgent: AgentInfo | undefined
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedLabel = value ? agentLabel(value) : loaded ? 'Select agent' : 'Loading agents'

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
      const menuWidth = 220
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.left)),
        top: rect.bottom + 4,
      })
    }
    setOpen((current) => !current)
  }

  return (
    <div>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        disabled={!loaded}
        className="pressable flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AgentIcon kind={value} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        {activeAgent?.available === false && <span className="text-muted-foreground">Missing</span>}
      </button>
      {open && (
        <div ref={menuRef} className="popover-enter fixed z-50 w-[220px] rounded-md border bg-popover p-1 shadow-xl shadow-black/10" style={position}>
          {options.map((option) => (
            <button
              key={option.kind}
              type="button"
              disabled={!option.available}
              onClick={() => {
                onChange(option.kind)
                setOpen(false)
              }}
              className={cn(
                'pressable flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                option.kind === value && 'bg-accent font-medium',
              )}
            >
              <AgentIcon kind={option.kind} className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{agentLabel(option.kind)}</span>
              {option.kind === value && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentIcon({ kind, className }: { kind: string; className?: string }) {
  const icon = simpleIconForAgent(kind)
  if (!icon) return <Bot className={className} />

  return (
    <svg className={className} role="img" aria-label={icon.title} viewBox="0 0 24 24" fill="currentColor">
      <path d={icon.path} />
    </svg>
  )
}

function simpleIconForAgent(kind: string): { title: string; path: string } | null {
  const key = kind.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (key === 'anthropic') return siAnthropic
  if (key === 'claude') return siClaude
  if (key === 'claudecode') return siClaudecode
  if (key === 'pi') return siPi
  return null
}

function readAgentKind(config: Record<string, unknown> | undefined) {
  const agent = isRecord(config?.agent) ? config.agent : {}
  return typeof agent.kind === 'string' ? agent.kind : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
