import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Bot, Check, Github } from 'lucide-react'
import { EditableLabels, StatusPicker } from '@/components/issues/IssueControls'
import { PropertyField, PropertyPanel } from '@/components/project/PropertyPanel'
import { ProjectTabs } from '@/components/project/ProjectTabs'
import { useProjects } from '@/components/project/ProjectProvider'
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
                  placeholder="agent 项目编排"
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
              <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 hover:bg-muted focus-within:bg-muted">
                <Github className="size-3.5 shrink-0 text-muted-foreground" />
                <Input
                  value={githubLink}
                  onChange={(event) => setGithubLink(event.target.value)}
                  aria-label="Project repository"
                  placeholder="owner/repo"
                  className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                  title={githubLink}
                />
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
    </div>
  )
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
        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
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
              <Bot className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{agentLabel(option.kind)}</span>
              {option.kind === value && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function readAgentKind(config: Record<string, unknown> | undefined) {
  const agent = isRecord(config?.agent) ? config.agent : {}
  return typeof agent.kind === 'string' ? agent.kind : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
