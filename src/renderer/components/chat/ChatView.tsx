import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { Activity, Archive, Bot, Brain, Check, ChevronDown, ChevronRight, Circle, FileJson, LoaderCircle, MessageSquare, Pencil, Plus, Sparkles, StopCircle, Terminal, Wrench } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MessageBubble as SharedMessageBubble, appendMessageParts as mergeMessageParts, markMessagePartsDone as finishMessageParts, normalizeStoredParts as normalizeSharedStoredParts, splitAgentOutput as parseAgentOutput } from '@/components/chat/MessageSurface'
import { ProjectTabs } from '@/components/project/ProjectTabs'
import { PromptComposer } from '@/components/project/PromptComposer'
import { cn } from '@/lib/utils'
import { useProjects } from '@/components/project/ProjectProvider'
import { electronClient } from '@/shared/api/electron-client'

// ─── Types ────────────────────────────────────────────────

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  parts?: MessagePart[]
  stream?: 'stderr'
}

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; state?: 'streaming' | 'done' }
  | { type: 'tool-call'; id?: string; name: string; args?: unknown; state?: 'running' | 'done' | 'error' }
  | { type: 'tool-result'; id?: string; name: string; result?: unknown; text?: string; isError?: boolean }
  | { type: 'event'; name: string; text?: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }

interface Session {
  id: string
  name: string
  createdAt: string
  model?: string
  archived?: boolean
}

interface EngineSnapshot {
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
    retrying: Array<{ key: string; projectPath: string; issueId: string; title: string; attempt?: number; nextRetryAt?: string | null; lastError?: string | null }>
    maxConcurrent: number
    claimedCount: number
  }
}

const SESSION_SIDEBAR_MIN_WIDTH = 160
const SESSION_SIDEBAR_MAX_WIDTH = 360
const SESSION_SIDEBAR_DEFAULT_WIDTH = 192
const SESSION_SIDEBAR_WIDTH_KEY = 'pai.chatSessionSidebarWidth'

// ─── Model & thinking presets ─────────────────────────────

const THINKING_LEVELS: Record<string, string[]> = {
  codex: ['off', 'low', 'medium', 'high'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['off', 'low', 'medium', 'high'],
}

const DEFAULT_MODEL: Record<string, string> = { codex: '', pi: '', claude: '' }
const DEFAULT_THINKING: Record<string, string> = { codex: 'medium', pi: 'medium', claude: 'medium' }
const MARKDOWN_PLUGINS = [remarkGfm]

function loadSessionSidebarWidth() {
  try {
    const storedWidth = Number(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(storedWidth)) {
      return Math.min(SESSION_SIDEBAR_MAX_WIDTH, Math.max(SESSION_SIDEBAR_MIN_WIDTH, storedWidth))
    }
  } catch {
    // Ignore storage failures.
  }
  return SESSION_SIDEBAR_DEFAULT_WIDTH
}

// ─── Component ────────────────────────────────────────────

export function ChatView() {
  // Agent config
  const [agentKind, setAgentKind] = useState('codex')
  const [model, setModel] = useState('')
  const [projectModel, setProjectModel] = useState('')
  const [thinking, setThinking] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [hasConfiguredModels, setHasConfiguredModels] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)

  // Session management
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>('')
  const [messagesBySession, setMessagesBySession] = useState<Map<string, Message[]>>(new Map())
  const [renamingSessionId, setRenamingSessionId] = useState('')
  const [renameValue, setRenameValue] = useState('')

  // Chat state
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runSessionId, setRunSessionId] = useState<string | null>(null)
  const [assistantContent, setAssistantContent] = useState('')
  const [assistantThinking, setAssistantThinking] = useState('')
  const [assistantParts, setAssistantParts] = useState<MessagePart[]>([])
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(loadSessionSidebarWidth)
  const [engineSnapshot, setEngineSnapshot] = useState<EngineSnapshot | null>(null)
  const [engineOpen, setEngineOpen] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const outputCleanup = useRef<(() => void) | null>(null)
  const doneCleanup = useRef<(() => void) | null>(null)
  const loadedMessages = useRef<Set<string>>(new Set())
  const sidebarDragging = useRef(false)
  const { name } = useParams()
  const { getProject } = useProjects()
  const project = getProject(name)

  const activeMessages = messagesBySession.get(activeSessionId) ?? []
  const activeSessions = sessions.filter((session) => !session.archived)
  const archivedSessions = sessions.filter((session) => session.archived)

  // ── Load sessions first; agent/model detection can be slower ──

  useEffect(() => {
    if (!project?.path) return
    const projectPath = project.path
    loadedMessages.current.clear()
    setMessagesBySession(new Map())
    ;(async () => {
      let savedSessions = await electronClient?.readSessions(projectPath) ?? []
      if (savedSessions.length === 0) {
        savedSessions = [{ id: 'default', name: 'Default', createdAt: new Date().toISOString() }]
        await electronClient?.writeSessions(projectPath, savedSessions)
      }
      setSessions(savedSessions)
      setActiveSessionId(savedSessions[0]!.id)
    })()
  }, [project?.path])

  useEffect(() => {
    if (!project?.path) return
    const projectPath = project.path
    let cancelled = false
    ;(async () => {
      const cfg = await electronClient?.readAgentConfig(projectPath)
      if (cancelled) return

      const { kind, savedModel, configuredModels, thinking: savedThinking } = parseAgentConfig(cfg, 'codex', '')
      const projectModels = savedModel && !configuredModels.includes(savedModel)
        ? [savedModel, ...configuredModels]
        : configuredModels
      setAgentKind(kind)
      setProjectModel(savedModel)
      setHasConfiguredModels(projectModels.length > 0)
      setModels(projectModels)
      setThinking(savedThinking || DEFAULT_THINKING[kind] || 'medium')
      setConfigLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [project?.path])

  // Save agent config on model/thinking change
  useEffect(() => {
    if (!project?.path || !configLoaded || !agentKind) return
    electronClient?.writeAgentConfig(project.path, { kind: agentKind, model: projectModel || '', thinking: thinking || DEFAULT_THINKING[agentKind] || 'medium' })
  }, [agentKind, configLoaded, project?.path, projectModel, thinking])

  useEffect(() => {
    if (!agentKind || !configLoaded || hasConfiguredModels) return
    let cancelled = false
    ;(async () => {
      const detectedModels = await electronClient?.listModels(agentKind)
      if (cancelled || !detectedModels) return
      setModels(uniqueStrings(detectedModels))
    })()

    return () => {
      cancelled = true
    }
  }, [agentKind, configLoaded, hasConfiguredModels])

  useEffect(() => {
    if (!configLoaded) return
    const activeSession = sessions.find((session) => session.id === activeSessionId)
    const preferredModel = activeSession?.model || projectModel || DEFAULT_MODEL[agentKind] || ''
    if (preferredModel && (models.length === 0 || models.includes(preferredModel))) {
      setModel(preferredModel)
      return
    }
    setModel(models[0] ?? '')
  }, [activeSessionId, agentKind, configLoaded, models, projectModel, sessions])

  // Load messages when switching sessions
  useEffect(() => {
    if (!project?.path || !activeSessionId) return
    if (loadedMessages.current.has(activeSessionId)) return

    loadedMessages.current.add(activeSessionId)
    electronClient?.readChatLogs(project.path, activeSessionId).then((logs) => {
      const msgs: Message[] = logs.map((l) => ({
        id: l.timestamp || String(Date.now()),
        role: l.role as 'user' | 'assistant',
        content: l.content,
        thinking: l.thinking,
        parts: normalizeSharedStoredParts(l.parts),
      }))
      setMessagesBySession((prev) => {
        const next = new Map(prev)
        next.set(activeSessionId, msgs)
        return next
      })
    })
  }, [activeSessionId, project?.path])

  useEffect(() => {
    if (!project?.path) return

    const projectPath = project.path
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    electronClient?.watchProject(projectPath, (data) => {
      if (data.projectPath !== projectPath) return
      void (async () => {
        const [savedSessions, cfg] = await Promise.all([
          electronClient?.readSessions(projectPath) ?? Promise.resolve([]),
          electronClient?.readAgentConfig(projectPath),
        ])
        if (cancelled) return

        if (savedSessions.length > 0) {
          setSessions(savedSessions)
          if (activeSessionId && !savedSessions.some((session) => session.id === activeSessionId)) {
            setActiveSessionId(savedSessions.find((session) => !session.archived)?.id ?? savedSessions[0]!.id)
          }
        }

        if (activeSessionId) {
          const logs = await electronClient?.readChatLogs(projectPath, activeSessionId)
          if (cancelled || !logs) return
          const msgs: Message[] = logs.map((l) => ({
            id: l.timestamp || String(Date.now()),
            role: l.role as 'user' | 'assistant',
            content: l.content,
            thinking: l.thinking,
            parts: normalizeSharedStoredParts(l.parts),
          }))
          loadedMessages.current.add(activeSessionId)
          setMessagesBySession((prev) => {
            const next = new Map(prev)
            next.set(activeSessionId, msgs)
            return next
          })
        }

        const {
          kind,
          savedModel,
          configuredModels,
          thinking: savedThinking,
        } = parseAgentConfig(cfg, agentKind, model)
        const projectModels = savedModel && !configuredModels.includes(savedModel)
          ? [savedModel, ...configuredModels]
          : configuredModels
        setAgentKind(kind)
        setProjectModel(savedModel)
        setHasConfiguredModels(projectModels.length > 0)
        setModels(projectModels)
        setThinking(savedThinking || thinking || DEFAULT_THINKING[kind] || 'medium')
        setConfigLoaded(true)
      })()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [activeSessionId, agentKind, model, project?.path, thinking])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeMessages, activeSessionId, assistantContent, assistantThinking, assistantParts, running])

  useEffect(() => {
    function handleMouseMove(event: globalThis.MouseEvent) {
      if (!sidebarDragging.current) return
      const nextWidth = Math.min(
        SESSION_SIDEBAR_MAX_WIDTH,
        Math.max(SESSION_SIDEBAR_MIN_WIDTH, window.innerWidth - event.clientX),
      )
      setSessionSidebarWidth(nextWidth)
      localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(nextWidth))
    }

    function handleMouseUp() {
      sidebarDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    return () => { outputCleanup.current?.(); doneCleanup.current?.() }
  }, [])

  useEffect(() => {
    if (!electronClient?.getEngineSnapshot) return
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

  // ── Submit ───────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || running || !agentKind || !activeSessionId) return

    const prompt = input.trim()
    setInput('')
    setAssistantContent('')
    setAssistantThinking('')
    setAssistantParts([])
    setRunning(true)

    const userMsg: Message = { id: String(Date.now()), role: 'user', content: prompt, parts: [{ type: 'text', text: prompt }] }
    setMessagesBySession((prev) => {
      const next = new Map(prev)
      next.set(activeSessionId, [...(next.get(activeSessionId) ?? []), userMsg])
      return next
    })
    if (project?.path) {
      await electronClient?.appendChatLog(project.path, activeSessionId, { role: 'user', content: prompt, parts: userMsg.parts })
    }

    const projectPath = project?.path ?? ''
    outputCleanup.current?.()
    doneCleanup.current?.()

    const { sessionId: runId } = await electronClient!.startChat({
      agentKind,
      model: model || models[0] || '',
      thinking: thinking || DEFAULT_THINKING[agentKind] || 'medium',
      message: prompt,
      workspacePath: projectPath,
      sessionId: activeSessionId,
    })

    setRunSessionId(runId)
    let streamedContent = ''
    let streamedThinking = ''
    let streamedParts: MessagePart[] = []

    outputCleanup.current = electronClient!.onAgentOutput((data) => {
      if (data.sessionId !== runId) return
      const parsed = parseAgentOutput(data.text, data.stream)
      streamedThinking += parsed.thinking
      streamedContent += parsed.content
      streamedParts = mergeMessageParts(streamedParts, parsed.parts)
      setAssistantThinking(streamedThinking)
      setAssistantContent(streamedContent)
      setAssistantParts(streamedParts)
    })

    doneCleanup.current = electronClient!.onAgentDone((data) => {
      if (data.sessionId !== runId) return
      const assistantMsg: Message = {
        id: String(Date.now()),
        role: 'assistant',
        content: streamedContent.trim() || (data.error ?? 'No output'),
        thinking: streamedThinking.trim() || undefined,
        parts: streamedParts.length ? finishMessageParts(streamedParts) : undefined,
        stream: data.error ? 'stderr' : undefined,
      }
      setMessagesBySession((prev) => {
        const next = new Map(prev)
        next.set(activeSessionId, [...(next.get(activeSessionId) ?? []), assistantMsg])
        return next
      })
      if (project?.path) {
        electronClient?.appendChatLog(project.path, activeSessionId, {
          role: 'assistant',
          content: assistantMsg.content,
          thinking: assistantMsg.thinking,
          parts: assistantMsg.parts,
        })
      }
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
      setRunning(false)
      setRunSessionId(null)
    })
  }, [input, running, agentKind, model, thinking, models, project, activeSessionId])

  const handleCancel = useCallback(async () => {
    if (runSessionId) await electronClient?.cancelChat(runSessionId)
  }, [runSessionId])

  // ── Session actions ──────────────────────────────────

  const handleNewSession = useCallback(async () => {
    const newSession: Session = {
      id: `session-${Date.now()}`,
      name: `Session ${sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      model: model || projectModel || models[0] || undefined,
    }
    const updated = [...sessions, newSession]
    setSessions(updated)
    loadedMessages.current.add(newSession.id)
    setMessagesBySession((prev) => {
      const next = new Map(prev)
      next.set(newSession.id, [])
      return next
    })
    if (project?.path) await electronClient?.writeSessions(project.path, updated)
    setActiveSessionId(newSession.id)
  }, [model, models, project, projectModel, sessions])

  const persistSessions = useCallback(async (updated: Session[]) => {
    setSessions(updated)
    if (project?.path) await electronClient?.writeSessions(project.path, updated)
  }, [project?.path])

  const handleRenameStart = useCallback((session: Session) => {
    if (session.id === 'default') return
    setRenamingSessionId(session.id)
    setRenameValue(session.name)
  }, [])

  const handleRenameCommit = useCallback(async () => {
    if (!renamingSessionId) return
    const nextName = renameValue.trim()
    if (!nextName) return

    const updated = sessions.map((session) =>
      session.id === renamingSessionId ? { ...session, name: nextName } : session,
    )
    setRenamingSessionId('')
    setRenameValue('')
    await persistSessions(updated)
  }, [persistSessions, renameValue, renamingSessionId, sessions])

  const handleRenameCancel = useCallback(() => {
    setRenamingSessionId('')
    setRenameValue('')
  }, [])

  const handleArchiveSession = useCallback(async (id: string) => {
    if (id === 'default') return

    const updated = sessions.map((session) =>
      session.id === id ? { ...session, archived: true } : session,
    )
    await persistSessions(updated)

    if (activeSessionId === id) {
      const nextActive = updated.find((session) => !session.archived)?.id ?? 'default'
      setActiveSessionId(nextActive)
    }
  }, [activeSessionId, persistSessions, sessions])

  const handleModelChange = useCallback(async (nextModel: string) => {
    setModel(nextModel)
    if (!activeSessionId) return

    const updated = sessions.map((session) => (
      session.id === activeSessionId ? { ...session, model: nextModel } : session
    ))
    await persistSessions(updated)
  }, [activeSessionId, persistSessions, sessions])

  // ── Derived ──────────────────────────────────────────

  const thinkingLevels = THINKING_LEVELS[agentKind] ?? ['off', 'low', 'medium', 'high']
  const agentLabel = { codex: 'Codex', pi: 'Pi', claude: 'Claude' }[agentKind] ?? agentKind
  const modelOptions = models
  const modelSelectValue = modelOptions.includes(model) ? model : modelOptions[0] ?? ''
  const hasStreamingMessage = assistantContent || assistantThinking || assistantParts.length > 0

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectTabs />

      <div className="flex min-h-0 flex-1 bg-background/65">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="content-enter mx-auto flex w-full max-w-5xl flex-col gap-5 py-6 pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] pr-8 lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10">
              {activeMessages.length === 0 && !running ? (
                <div className="flex flex-col items-center gap-3 pt-20 text-center">
                  <div className="flex size-12 items-center justify-center rounded-xl border bg-[hsl(var(--surface-raised))] shadow-sm shadow-black/[0.03]">
                    <Sparkles className="size-5 text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium">Start a conversation with {agentLabel}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Messages are stored as Pai sessions.</p>
                  </div>
                </div>
              ) : (
                activeMessages.map((msg) => <SharedMessageBubble key={msg.id} message={msg} />)
              )}

              {running && hasStreamingMessage && (
                <SharedMessageBubble message={{ id: 'stream', role: 'assistant', content: assistantContent, thinking: assistantThinking, parts: assistantParts }} streaming />
              )}
              {running && !hasStreamingMessage && (
                <div className="flex items-center gap-1 px-1">
                  <div className="flex items-center gap-1">
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '0ms' }} />
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '120ms' }} />
                    <span className="typing-dot inline-block size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '240ms' }} />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <PromptComposer
            value={input} onChange={setInput} onSubmit={handleSubmit}
            disabled={running}
            showTopBorder={false}
            placeholder={running ? `${agentLabel} is responding...` : `Message ${agentLabel}...`}
            className="pl-[calc(var(--traffic-light-safe-width,0px)+2rem)] pr-8 lg:pl-[calc(var(--traffic-light-safe-width,0px)+2.5rem)] lg:pr-10"
            controls={
              running ? (
                <button onClick={handleCancel} className="pressable flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
                  <StopCircle className="size-3.5" /> Stop
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  {modelOptions.length > 0 && (
                    <MiniSelect value={modelSelectValue} onChange={handleModelChange} options={modelOptions} label="Model" />
                  )}
                  <MiniSelect value={thinking || DEFAULT_THINKING[agentKind] || 'medium'} onChange={setThinking} options={thinkingLevels} label="Think" />
                </div>
              )
            }
          />
        </div>

        {/* Session sidebar */}
        <aside
          className="relative hidden shrink-0 flex-col border-l bg-muted/30 lg:flex"
          style={{ width: sessionSidebarWidth }}
        >
          <div
            className="absolute left-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/25"
            onMouseDown={() => {
              sidebarDragging.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          />
          <div className="flex items-center justify-between border-b bg-background/35 px-3 py-3">
            <span className="text-sm font-semibold">Sessions</span>
            <button onClick={handleNewSession} className="pressable rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground" aria-label="New session">
              <Plus className="size-3.5" />
            </button>
          </div>
          <EngineStatus
            snapshot={engineSnapshot}
            projectPath={project?.path}
            open={engineOpen}
            onToggle={() => setEngineOpen((value) => !value)}
          />
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 p-2">
              <SessionGroup
                sessions={activeSessions}
                activeSessionId={activeSessionId}
                running={running}
                renamingSessionId={renamingSessionId}
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                onRenameStart={handleRenameStart}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={handleRenameCancel}
                onArchive={handleArchiveSession}
                onSelect={setActiveSessionId}
              />
              {archivedSessions.length > 0 && (
                <>
                  <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Archived</div>
                  <SessionGroup
                    sessions={archivedSessions}
                    activeSessionId={activeSessionId}
                    running={running}
                    renamingSessionId={renamingSessionId}
                    renameValue={renameValue}
                    archived
                    onRenameValueChange={setRenameValue}
                    onRenameStart={handleRenameStart}
                    onRenameCommit={handleRenameCommit}
                    onRenameCancel={handleRenameCancel}
                    onArchive={handleArchiveSession}
                    onSelect={setActiveSessionId}
                  />
                </>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────

function EngineStatus({
  snapshot,
  projectPath,
  open,
  onToggle,
}: {
  snapshot: EngineSnapshot | null
  projectPath?: string
  open: boolean
  onToggle: () => void
}) {
  const runningIssues = snapshot?.issueRuns.running.filter((run) => run.projectPath === projectPath) ?? []
  const queuedIssues = snapshot?.issueRuns.queued.filter((run) => run.projectPath === projectPath) ?? []
  const retryingIssues = snapshot?.issueRuns.retrying.filter((run) => run.projectPath === projectPath) ?? []
  const runningSessions = snapshot?.sessions.running ?? []
  const activeCount = runningIssues.length + runningSessions.length
  const queuedCount = queuedIssues.length + retryingIssues.length
  const isActive = activeCount > 0
  const hasWork = isActive || queuedCount > 0

  return (
    <div className="border-b bg-background/45">
      <button
        onClick={onToggle}
        className="pressable flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-background/70"
        aria-expanded={open}
      >
        <span className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground',
          hasWork && 'text-foreground',
        )}>
          {isActive ? <LoaderCircle className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">Engine</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {activeCount ? `${activeCount} running` : 'idle'}{queuedCount ? `, ${queuedCount} queued` : ''}
          </span>
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="popover-enter px-3 pb-3">
          <div className="grid grid-cols-2 gap-1.5">
            <EngineMetric label="Run" value={String(activeCount)} active={activeCount > 0} />
            <EngineMetric label="Queue" value={String(queuedCount)} active={queuedCount > 0} />
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {runningIssues.length > 0 && (
              <EngineRunList icon="run" title="Issues" items={runningIssues.map((run) => run.title || run.issueId)} />
            )}
            {queuedIssues.length > 0 && (
              <EngineRunList icon="queue" title="Queued" items={queuedIssues.map((run) => run.title || run.issueId)} />
            )}
            {retryingIssues.length > 0 && (
              <EngineRunList icon="queue" title="Retrying" items={retryingIssues.map((run) => run.title || run.issueId)} />
            )}
            {runningSessions.length > 0 && (
              <EngineRunList icon="session" title="Sessions" items={runningSessions} />
            )}
            {!hasWork && (
              <div className="rounded-md border border-dashed bg-muted/20 px-2 py-2 text-[11px] text-muted-foreground">
                No background work.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EngineMetric({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className={cn(
      'rounded-md border bg-background/45 px-2 py-1.5 shadow-sm shadow-black/[0.02]',
      active && 'bg-background ring-1 ring-border/70',
    )}>
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold leading-5">{value}</div>
    </div>
  )
}

function EngineRunList({ icon, title, items }: { icon: 'run' | 'queue' | 'session'; title: string; items: string[] }) {
  const Icon = icon === 'session' ? Bot : icon === 'run' ? LoaderCircle : Circle
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className={cn('size-3', icon === 'run' && 'animate-spin')} />
        <span>{title}</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.slice(0, 4).map((item) => (
          <div key={item} className="truncate rounded-md bg-muted/35 px-2 py-1 text-[11px] text-foreground/80" title={item}>
            {item}
          </div>
        ))}
        {items.length > 4 && (
          <div className="px-2 text-[11px] text-muted-foreground">+{items.length - 4}</div>
        )}
      </div>
    </div>
  )
}

function SessionGroup({
  sessions,
  activeSessionId,
  running,
  renamingSessionId,
  renameValue,
  archived = false,
  onRenameValueChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onArchive,
  onSelect,
}: {
  sessions: Session[]
  activeSessionId: string
  running: boolean
  renamingSessionId: string
  renameValue: string
  archived?: boolean
  onRenameValueChange: (value: string) => void
  onRenameStart: (session: Session) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onArchive: (id: string) => void
  onSelect: (id: string) => void
}) {
  return (
    <>
      {sessions.map((session) => {
        const isDefault = session.id === 'default'
        const isRenaming = renamingSessionId === session.id

        return (
          <div key={session.id} className="group flex items-center gap-1">
            <button
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => onRenameStart(session)}
              className={cn(
                'pressable flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                session.id === activeSessionId ? 'bg-background font-medium shadow-sm ring-1 ring-border/70' : 'hover:bg-background/70',
                archived && 'text-muted-foreground',
              )}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              {isRenaming ? (
                <input
                  value={renameValue}
                  onChange={(event) => onRenameValueChange(event.target.value)}
                  onBlur={onRenameCommit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRenameCommit()
                    if (event.key === 'Escape') onRenameCancel()
                  }}
                  className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-xs outline-none ring-1 ring-ring"
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="flex-1 truncate">{session.name}</span>
              )}
              {session.id === activeSessionId && running && (
                <Circle className="size-1.5 fill-current stroke-0 text-foreground" />
              )}
            </button>

            {!isDefault && !isRenaming && (
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => onRenameStart(session)}
                  className="pressable rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={`Rename ${session.name}`}
                >
                  <Pencil className="size-3" />
                </button>
                {!archived && (
                  <button
                    onClick={() => onArchive(session.id)}
                    className="pressable rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Archive ${session.name}`}
                  >
                    <Archive className="size-3" />
                  </button>
                )}
              </div>
            )}

            {!isDefault && isRenaming && (
              <button
                onClick={onRenameCommit}
                className="pressable shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label="Confirm rename"
              >
                <Check className="size-3" />
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

function MiniSelect({ value, onChange, options, label, disabled }: { value: string; onChange: (v: string) => void; options: string[]; label: string; disabled?: boolean }) {
  return (
    <div className="relative min-w-0">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={label} className="h-8 max-w-56 truncate appearance-none rounded-md border bg-background/70 px-2 pr-5 text-[11px] font-medium text-muted-foreground transition-[background-color,border-color,box-shadow] duration-150 [transition-timing-function:var(--ease-out)] hover:border-muted-foreground/25 hover:bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-70">
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0.5 top-1/2 size-2.5 -translate-y-1/2 text-muted-foreground/50" />
    </div>
  )
}

function MessageBubble({ message, streaming }: { message: Message; streaming?: boolean }) {
  const isUser = message.role === 'user'
  const isError = message.stream === 'stderr'
  const parts = getMessageParts(message, streaming)

  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div className={cn(
        'content-enter max-w-[88%] rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm shadow-black/[0.025]',
        isUser ? 'border-primary/15 bg-primary text-primary-foreground' : isError ? 'border-destructive/35 bg-destructive/10 text-foreground' : 'bg-[hsl(var(--surface-raised))]',
        streaming && 'border-dashed',
      )}>
        <div className="flex flex-col gap-3">
          {parts.map((part, index) => (
            <MessagePartView key={`${part.type}-${index}`} part={part} streaming={streaming} isUser={isUser} />
          ))}
        </div>
        {streaming && <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-muted-foreground align-middle" />}
      </div>
    </div>
  )
}

function MessagePartView({ part, streaming, isUser }: { part: MessagePart; streaming?: boolean; isUser: boolean }) {
  if (part.type === 'text') {
    return <MarkdownText text={part.text} isUser={isUser} />
  }

  if (part.type === 'thinking') {
    return (
      <details className={cn('rounded-md border px-3 py-2 text-xs', isUser ? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/85' : 'bg-muted/35 text-muted-foreground')} open={streaming}>
        <summary className={cn('group flex cursor-pointer select-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden', isUser ? 'text-primary-foreground/85' : 'text-foreground/75')}>
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <Brain className="size-3" />
          Thinking
        </summary>
        <pre className="mt-2 whitespace-pre-wrap font-sans leading-5">{part.text}</pre>
      </details>
    )
  }

  if (part.type === 'tool-call') {
    return (
      <ToolFrame icon={<Wrench className="size-3" />} title={part.name} meta={part.state === 'running' ? 'running' : part.state}>
        {part.args !== undefined && <JsonBlock value={part.args} />}
      </ToolFrame>
    )
  }

  if (part.type === 'tool-result') {
    return (
      <ToolFrame icon={<FileJson className="size-3" />} title={part.name} meta={part.isError ? 'error' : 'result'} tone={part.isError ? 'error' : 'default'}>
        {part.text ? <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre> : <JsonBlock value={part.result} />}
      </ToolFrame>
    )
  }

  if (part.type === 'log') {
    return (
      <ToolFrame icon={<Terminal className="size-3" />} title={part.stream} tone={part.stream === 'stderr' ? 'error' : 'default'}>
        <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre>
      </ToolFrame>
    )
  }

  return (
    <ToolFrame icon={<Circle className="size-3" />} title={part.name}>
      {part.text && <pre className="whitespace-pre-wrap font-sans leading-5">{part.text}</pre>}
    </ToolFrame>
  )
}

function MarkdownText({ text, isUser }: { text: string; isUser: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_PLUGINS}
      skipHtml
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        a: ({ children, href }) => (
          <a
            href={href}
            className={cn('font-medium underline underline-offset-4', isUser ? 'text-primary-foreground' : 'text-primary')}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="my-1 pl-1">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className={cn('my-3 border-l-2 pl-3 italic', isUser ? 'border-primary-foreground/35' : 'border-border text-muted-foreground')}>
            {children}
          </blockquote>
        ),
        h1: ({ children }) => <h1 className="mb-3 mt-1 text-lg font-semibold leading-7">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold leading-6">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold leading-6">{children}</h3>,
        hr: () => <div className={cn('my-4 border-t', isUser ? 'border-primary-foreground/25' : 'border-border')} />,
        table: ({ children }) => (
          <div className="my-3 max-w-full overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border-b bg-muted/45 px-2 py-1.5 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-b px-2 py-1.5 align-top last:border-b-0">{children}</td>,
        code: ({ children, className }) => (
          <code className={cn(className ? 'font-mono text-[12px]' : 'rounded bg-muted/70 px-1 py-0.5 font-mono text-[12px]', isUser && !className && 'bg-primary-foreground/15')}>
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className={cn('my-3 max-w-full overflow-x-auto rounded-md p-3 font-mono text-xs leading-5', isUser ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted/60 text-foreground')}>
            {children}
          </pre>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function ToolFrame({
  children,
  icon,
  title,
  meta,
  tone = 'default',
}: {
  children?: ReactNode
  icon: ReactNode
  title: string
  meta?: string
  tone?: 'default' | 'error'
}) {
  return (
    <div className={cn('rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground', tone === 'error' && 'border-destructive/35 bg-destructive/10 text-foreground')}>
      <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/75">
        {icon}
        <span className="truncate">{title}</span>
        {meta && <span className="ml-auto shrink-0 rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{meta}</span>}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 font-mono text-[11px] leading-5 text-foreground/80">
      {formatJsonValue(value)}
    </pre>
  )
}

function getMessageParts(message: Message, streaming?: boolean): MessagePart[] {
  if (message.parts?.length) {
    return streaming ? markMessagePartsStreaming(message.parts) : message.parts
  }

  const parts: MessagePart[] = []
  if (message.thinking) parts.push({ type: 'thinking', text: message.thinking, state: streaming ? 'streaming' : 'done' })
  if (message.content) parts.push({ type: 'text', text: message.content })
  return parts
}

function markMessagePartsStreaming(parts: MessagePart[]) {
  return parts.map((part) => part.type === 'thinking' ? { ...part, state: 'streaming' as const } : part)
}

function markMessagePartsDone(parts: MessagePart[]) {
  return parts.map((part) => {
    if (part.type === 'thinking') return { ...part, state: 'done' as const }
    if (part.type === 'tool-call' && part.state === 'running') return { ...part, state: 'done' as const }
    return part
  })
}

function appendMessageParts(current: MessagePart[], incoming: MessagePart[]) {
  if (incoming.length === 0) return current
  return [...current, ...incoming]
}

function normalizeStoredParts(value: unknown): MessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.map(normalizeMessagePart).filter((part): part is MessagePart => Boolean(part))
  return parts.length ? parts : undefined
}

function normalizeMessagePart(value: unknown): MessagePart | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text }
  if (value.type === 'thinking' && typeof value.text === 'string') {
    return {
      type: 'thinking',
      text: value.text,
      state: value.state === 'streaming' || value.state === 'done' ? value.state : undefined,
    }
  }
  if (value.type === 'tool-call' && typeof value.name === 'string') {
    return {
      type: 'tool-call',
      id: typeof value.id === 'string' ? value.id : undefined,
      name: value.name,
      args: value.args,
      state: value.state === 'running' || value.state === 'done' || value.state === 'error' ? value.state : undefined,
    }
  }
  if (value.type === 'tool-result' && typeof value.name === 'string') {
    return {
      type: 'tool-result',
      id: typeof value.id === 'string' ? value.id : undefined,
      name: value.name,
      result: value.result,
      text: typeof value.text === 'string' ? value.text : undefined,
      isError: value.isError === true,
    }
  }
  if (value.type === 'event' && typeof value.name === 'string') {
    return { type: 'event', name: value.name, text: typeof value.text === 'string' ? value.text : undefined }
  }
  if (value.type === 'log' && (value.stream === 'stdout' || value.stream === 'stderr') && typeof value.text === 'string') {
    return { type: 'log', stream: value.stream, text: value.text }
  }

  return null
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function parseAgentConfig(config: Record<string, unknown> | undefined, fallbackKind: string, fallbackModel: string) {
  const agent = isRecord(config?.agent) ? config.agent : {}
  const models = Array.isArray(agent.models)
    ? agent.models.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []

  return {
    kind: typeof agent.kind === 'string' && agent.kind ? agent.kind : fallbackKind,
    savedModel: typeof agent.model === 'string' ? agent.model : fallbackModel,
    configuredModels: models,
    thinking: typeof agent.thinking === 'string' ? agent.thinking : '',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function splitAgentOutput(text: string, stream?: string) {
  if (stream === 'stderr') {
    return { thinking: '', content: '', parts: [{ type: 'log' as const, stream: 'stderr' as const, text }] }
  }

  const parsed = parseStructuredAgentOutput(text)
  if (parsed) return parsed

  const thinkingLines: string[] = []
  const contentLines: string[] = []
  const parts: MessagePart[] = []
  for (const line of text.split('\n')) {
    if (/^\s*(thinking|reasoning|analysis|思考)\s*[:：]/i.test(line)) {
      const thinkingText = line.replace(/^\s*(thinking|reasoning|analysis|思考)\s*[:：]\s*/i, '')
      thinkingLines.push(thinkingText)
      parts.push({ type: 'thinking', text: thinkingText, state: 'streaming' })
    } else {
      contentLines.push(line)
    }
  }

  const content = contentLines.join('\n')
  if (content) parts.push({ type: 'text', text: content })

  return {
    thinking: thinkingLines.length ? `${thinkingLines.join('\n')}\n` : '',
    content,
    parts,
  }
}

function parseStructuredAgentOutput(text: string) {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  let parsedAny = false
  let thinking = ''
  let content = ''
  const parts: MessagePart[] = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      parsedAny = true
      const message = event?.message
      if (Array.isArray(message?.content)) {
        if (message.role === 'toolResult') {
          parts.push(readToolResultPart(message))
          continue
        }

        for (const item of message.content) {
          if (item?.type === 'thinking' && typeof item.thinking === 'string') {
            thinking += `${item.thinking}\n`
            parts.push({ type: 'thinking', text: item.thinking, state: 'streaming' })
          }
          if (item?.type === 'text' && typeof item.text === 'string') {
            content += item.text
            parts.push({ type: 'text', text: item.text })
          }
          const toolCall = readToolCallPart(item)
          if (toolCall) parts.push(toolCall)
          const toolResult = readInlineToolResultPart(item)
          if (toolResult) parts.push(toolResult)
        }
      } else if (typeof event?.text === 'string') {
        content += event.text
        parts.push({ type: 'text', text: event.text })
      } else if (event?.type && event.type !== 'message') {
        parts.push(readEventPart(event))
      }
    } catch {
      content += `${line}\n`
      parts.push({ type: 'text', text: `${line}\n` })
    }
  }

  return parsedAny ? { thinking, content, parts } : null
}

function readToolCallPart(item: unknown): MessagePart | null {
  if (!isRecord(item)) return null
  const type = typeof item.type === 'string' ? item.type : ''
  if (!['toolCall', 'tool_call', 'function_call'].includes(type)) return null

  const fn = isRecord(item.function) ? item.function : undefined
  const name = stringValue(item.name) ?? stringValue(item.toolName) ?? stringValue(fn?.name) ?? 'tool'
  return {
    type: 'tool-call',
    id: stringValue(item.id) ?? stringValue(item.toolCallId),
    name,
    args: parseMaybeJson(item.arguments ?? item.args ?? item.input ?? fn?.arguments),
    state: 'running',
  }
}

function readInlineToolResultPart(item: unknown): MessagePart | null {
  if (!isRecord(item)) return null
  const type = typeof item.type === 'string' ? item.type : ''
  if (!['toolResult', 'tool_result', 'function_result'].includes(type)) return null

  const result = item.result ?? item.output ?? item.content
  return {
    type: 'tool-result',
    id: stringValue(item.id) ?? stringValue(item.toolCallId),
    name: stringValue(item.name) ?? stringValue(item.toolName) ?? 'tool',
    result,
    text: resultToText(result),
    isError: item.isError === true,
  }
}

function readToolResultPart(message: Record<string, unknown>): MessagePart {
  const result = message.content
  return {
    type: 'tool-result',
    id: stringValue(message.toolCallId),
    name: stringValue(message.toolName) ?? 'tool',
    result,
    text: resultToText(result),
    isError: message.isError === true,
  }
}

function readEventPart(event: Record<string, unknown>): MessagePart {
  const name = stringValue(event.type) ?? 'event'
  const text = stringValue(event.content) ?? stringValue(event.message) ?? undefined
  return { type: 'event', name, text }
}

function resultToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : null)
      .filter((item): item is string => Boolean(item))
      .join('\n')
    return text || undefined
  }
  return undefined
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function formatJsonValue(value: unknown) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}
