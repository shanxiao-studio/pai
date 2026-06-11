import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Activity, Archive, Bot, Check, ChevronDown, ChevronRight, Circle, LoaderCircle, MessageSquare, Pencil, Plus, Sparkles, StopCircle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MessageBubble as SharedMessageBubble, type ChatMessage } from '@/components/chat/MessageSurface'
import { ProjectTabs } from '@/components/project/ProjectTabs'
import { PromptComposer } from '@/components/project/PromptComposer'
import { cn } from '@/lib/utils'
import { useProjects } from '@/components/project/ProjectProvider'
import { electronClient } from '@/shared/api/electron-client'
import {
  consumeAgentOutput,
  countRenderableAssistantMessages,
  createAssistantStreamState,
  finalizeAssistantStream,
  hasEquivalentMessage,
  hasAssistantStreamContent,
  normalizeLogMessages,
  type AgentOutputPayload,
  type PendingAssistantRun,
  shouldKeepWaitingForAssistantMessage,
} from '@/shared/agent-output'

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
const CHAT_BOTTOM_THRESHOLD = 96

// ─── Model & thinking presets ─────────────────────────────

const THINKING_LEVELS: Record<string, string[]> = {
  codex: ['off', 'low', 'medium', 'high'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['off', 'low', 'medium', 'high'],
}

const DEFAULT_MODEL: Record<string, string> = { codex: '', pi: '', claude: '' }
const DEFAULT_THINKING: Record<string, string> = { codex: 'medium', pi: 'medium', claude: 'medium' }

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

function areChatMessagesEqual(left: ChatMessage[] | undefined, right: ChatMessage[]) {
  if (!left || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const leftMessage = left[index]
    const rightMessage = right[index]
    if (!leftMessage || !rightMessage) return false
    if (
      leftMessage.id !== rightMessage.id ||
      leftMessage.role !== rightMessage.role ||
      leftMessage.content !== rightMessage.content ||
      (leftMessage.thinking ?? '') !== (rightMessage.thinking ?? '') ||
      (leftMessage.stream ?? '') !== (rightMessage.stream ?? '') ||
      JSON.stringify(leftMessage.parts ?? []) !== JSON.stringify(rightMessage.parts ?? [])
    ) return false
  }
  return true
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
  const [messagesBySession, setMessagesBySession] = useState<Map<string, ChatMessage[]>>(new Map())
  const [renamingSessionId, setRenamingSessionId] = useState('')
  const [renameValue, setRenameValue] = useState('')

  // Chat state
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runSessionId, setRunSessionId] = useState<string | null>(null)
  const [assistantContent, setAssistantContent] = useState('')
  const [assistantThinking, setAssistantThinking] = useState('')
  const [assistantParts, setAssistantParts] = useState<NonNullable<ChatMessage['parts']>>([])
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(loadSessionSidebarWidth)
  const [engineSnapshot, setEngineSnapshot] = useState<EngineSnapshot | null>(null)
  const [engineOpen, setEngineOpen] = useState(false)

  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const outputCleanup = useRef<(() => void) | null>(null)
  const doneCleanup = useRef<(() => void) | null>(null)
  const logLoadSeq = useRef<Map<string, number>>(new Map())
  const pendingRunRef = useRef<{ sessionId: string; state: PendingAssistantRun } | null>(null)
  const sidebarDragging = useRef(false)
  const shouldStickToBottom = useRef(true)
  const { name } = useParams()
  const { getProject } = useProjects()
  const project = getProject(name)

  const activeMessages = messagesBySession.get(activeSessionId) ?? []
  const activeSessions = sessions.filter((session) => !session.archived)

  const updateStickToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) {
      shouldStickToBottom.current = true
      return true
    }
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const isNearBottom = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD
    shouldStickToBottom.current = isNearBottom
    return isNearBottom
  }, [])

  const loadSessionMessages = useCallback(async (projectPath: string, sessionId: string) => {
    const nextSeq = (logLoadSeq.current.get(sessionId) ?? 0) + 1
    logLoadSeq.current.set(sessionId, nextSeq)
    const logs = await electronClient?.readChatLogs(projectPath, sessionId)
    if (!logs) return null
    if (logLoadSeq.current.get(sessionId) !== nextSeq) return null
    const msgs = normalizeLogMessages(logs)
    setMessagesBySession((prev) => {
      if (areChatMessagesEqual(prev.get(sessionId), msgs)) return prev
      const next = new Map(prev)
      next.set(sessionId, msgs)
      return next
    })
    return msgs
  }, [])

  // ── Load sessions first; agent/model detection can be slower ──

  useEffect(() => {
    if (!project?.path) return
    const projectPath = project.path
    logLoadSeq.current.clear()
    setMessagesBySession(new Map())
    ;(async () => {
      let savedSessions = await electronClient?.readSessions(projectPath) ?? []
      if (savedSessions.length === 0) {
        savedSessions = [{ id: 'default', name: 'Default', createdAt: new Date().toISOString() }]
        await electronClient?.writeSessions(projectPath, savedSessions)
      }
      setSessions(savedSessions)
      shouldStickToBottom.current = true
      setActiveSessionId(savedSessions[0]!.id)
      void loadSessionMessages(projectPath, savedSessions[0]!.id)
    })()
  }, [loadSessionMessages, project?.path])

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
    if (running && runSessionId === activeSessionId) return

    shouldStickToBottom.current = true
    void loadSessionMessages(project.path, activeSessionId)
  }, [activeSessionId, loadSessionMessages, project?.path, runSessionId, running])

  useEffect(() => {
    if (!project?.path || !activeSessionId) return
    if (running && runSessionId === activeSessionId) return

    const projectPath = project.path
    const sessionId = activeSessionId
    let cancelled = false

    async function refreshActiveSession() {
      if (cancelled) return
      await loadSessionMessages(projectPath, sessionId)
    }

    const timer = window.setInterval(refreshActiveSession, 1200)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeSessionId, loadSessionMessages, project?.path, runSessionId, running])

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

        if (activeSessionId && !(running && runSessionId === activeSessionId)) {
          await loadSessionMessages(projectPath, activeSessionId)
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
  }, [activeSessionId, agentKind, loadSessionMessages, model, project?.path, runSessionId, running, thinking])

  // Auto-scroll
  useEffect(() => {
    if (!shouldStickToBottom.current) return
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeMessages, activeSessionId, assistantContent, assistantThinking, assistantParts, running])

  useEffect(() => {
    if (!project?.path || !running || !runSessionId) return
    const projectPath = project.path
    const sessionId = runSessionId
    let cancelled = false

    async function refreshRunningSession() {
      const [status, loadedMessages] = await Promise.all([
        electronClient?.getAgentStatus(sessionId),
        loadSessionMessages(projectPath, sessionId),
      ])
      if (cancelled) return
      if (status && !status.running) {
        if (
          pendingRunRef.current?.sessionId === sessionId &&
          shouldKeepWaitingForAssistantMessage(loadedMessages, pendingRunRef.current.state)
        ) {
          return
        }
        pendingRunRef.current = null
        setAssistantContent('')
        setAssistantThinking('')
        setAssistantParts([])
        setRunning(false)
        setRunSessionId(null)
        outputCleanup.current?.()
        doneCleanup.current?.()
        outputCleanup.current = null
        doneCleanup.current = null
      }
    }

    void refreshRunningSession()
    const timer = window.setInterval(refreshRunningSession, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadSessionMessages, project?.path, runSessionId, running])

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

  const handleSubmit = useCallback(async (submittedValue?: string) => {
    const prompt = (submittedValue ?? input).trim()
    if (!prompt || running || !agentKind || !activeSessionId) return

    const expectedSessionId = activeSessionId
    const assistantMessagesBeforeRun = countRenderableAssistantMessages(messagesBySession.get(expectedSessionId) ?? [])
    setInput('')
    setAssistantContent('')
    setAssistantThinking('')
    setAssistantParts([])
    setRunning(true)
    setRunSessionId(expectedSessionId)
    pendingRunRef.current = {
      sessionId: expectedSessionId,
      state: {
        assistantMessagesBeforeRun,
        startedAt: Date.now(),
      },
    }
    shouldStickToBottom.current = true

    const userMsg: ChatMessage = { id: String(Date.now()), role: 'user', content: prompt, parts: [{ type: 'text', text: prompt }] }
    setMessagesBySession((prev) => {
      const next = new Map(prev)
      next.set(expectedSessionId, [...(next.get(expectedSessionId) ?? []), userMsg])
      return next
    })
    const projectPath = project?.path ?? ''
    outputCleanup.current?.()
    doneCleanup.current?.()

    let assistantState = createAssistantStreamState()
    outputCleanup.current = electronClient!.onAgentOutput((data: AgentOutputPayload) => {
      if (data.sessionId !== expectedSessionId) return
      if (updateStickToBottom()) shouldStickToBottom.current = true
      assistantState = consumeAgentOutput(assistantState, data)
      setAssistantThinking(assistantState.thinking)
      setAssistantContent(assistantState.content)
      setAssistantParts(assistantState.parts)
    })

    doneCleanup.current = electronClient!.onAgentDone((data) => {
      if (data.sessionId !== expectedSessionId) return
      const assistantMsg = hasAssistantStreamContent(assistantState) || data.error
        ? finalizeAssistantStream(assistantState, data.error)
        : null
      void (async () => {
        const loadedMessages = projectPath
          ? await loadSessionMessages(projectPath, expectedSessionId)
          : null

        if (
          assistantMsg &&
          (
            !loadedMessages ||
            (
              !hasEquivalentMessage(loadedMessages, assistantMsg) &&
              countRenderableAssistantMessages(loadedMessages) <= assistantMessagesBeforeRun
            )
          )
        ) {
          shouldStickToBottom.current = true
          setMessagesBySession((prev) => {
            const next = new Map(prev)
            next.set(expectedSessionId, [...(next.get(expectedSessionId) ?? []), assistantMsg])
            return next
          })
        }

        setAssistantContent('')
        setAssistantThinking('')
        setAssistantParts([])
        pendingRunRef.current = null
        setRunning(false)
        setRunSessionId(null)
        outputCleanup.current?.()
        doneCleanup.current?.()
        outputCleanup.current = null
        doneCleanup.current = null
      })()
    })

    try {
      const { sessionId: runId } = await electronClient!.startChat({
        agentKind,
        model: model || models[0] || '',
        thinking: thinking || DEFAULT_THINKING[agentKind] || 'medium',
        message: prompt,
        userMessage: prompt,
        workspacePath: projectPath,
        sessionId: expectedSessionId,
      })
      setRunSessionId(runId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start agent'
      setMessagesBySession((prev) => {
        const next = new Map(prev)
        next.set(expectedSessionId, [
          ...(next.get(expectedSessionId) ?? []),
          {
            id: String(Date.now()),
            role: 'assistant',
            content: message,
            stream: 'stderr',
            parts: [{ type: 'log', stream: 'stderr', text: message }],
          },
        ])
        return next
      })
      setAssistantContent('')
      setAssistantThinking('')
      setAssistantParts([])
      pendingRunRef.current = null
      setRunning(false)
      setRunSessionId(null)
      outputCleanup.current?.()
      doneCleanup.current?.()
      outputCleanup.current = null
      doneCleanup.current = null
    }
  }, [input, running, agentKind, model, thinking, models, project, activeSessionId, loadSessionMessages, messagesBySession])

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
  const hasStreamingMessage = hasAssistantStreamContent({
    content: assistantContent,
    thinking: assistantThinking,
    parts: assistantParts,
  })

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectTabs />

      <div className="flex min-h-0 flex-1 bg-background/65">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScrollArea viewportRef={scrollViewportRef} onViewportScroll={updateStickToBottom} className="min-h-0 flex-1">
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
            inputDisabled={running}
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
          <div key={session.id} className="group relative">
            <button
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => onRenameStart(session)}
              className={cn(
                'pressable flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                !isRenaming && !isDefault && 'pr-12',
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
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover:opacity-100">
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
                className="pressable absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
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
