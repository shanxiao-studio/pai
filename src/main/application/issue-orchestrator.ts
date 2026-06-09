import { AppEventBus } from '../core/app-event-bus'
import { appendAgentOutputEvent, createAssistantMessageAccumulator, finalizeAssistantMessage, hasAssistantMessageContent } from '../core/agent-output-aggregation'
import { AgentRunInput, EngineSnapshot, IssueOrchestratorConfig, IssueRuntimeState, ProjectIssue } from '../core/models'
import { AgentRegistry } from '../infra/agents/agent-registry'
import { AgentRuntime } from '../infra/agents/agent-runtime'
import { HookRunner } from '../infra/agents/hook-runner'
import { PaiStore } from '../infra/fs/pai-store'
import { issueSessionId } from '../infra/fs/pai-paths'

type RunningIssue = {
  key: string
  projectPath: string
  issue: ProjectIssue
  startedAt: string
}

export class IssueOrchestrator {
  private runtimeState = new Map<string, Record<string, IssueRuntimeState>>()
  private running = new Map<string, RunningIssue>()
  private queued = new Map<string, { key: string; projectPath: string; issue: ProjectIssue }>()
  private retrying = new Map<string, { key: string; projectPath: string; issue: ProjectIssue; nextRetryAt: string }>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly store: PaiStore,
    private readonly registry: AgentRegistry,
    private readonly runtime: AgentRuntime,
    private readonly hooks: HookRunner,
    private readonly events: AppEventBus,
  ) {}

  async onProjectIssuesChanged(projectPath: string) {
    await this.loadRuntimeState(projectPath)
    await this.tick(projectPath)
  }

  startProject(projectPath: string) {
    const key = `poll:${projectPath}`
    this.stopProject(projectPath)
    const schedule = async () => {
      const config = await this.readConfig(projectPath)
      if (!config.enabled) return
      await this.tick(projectPath)
      this.timers.set(key, setTimeout(schedule, config.pollIntervalMs))
    }
    void schedule()
  }

  stopProject(projectPath: string) {
    const key = `poll:${projectPath}`
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
  }

  async hydrateProject(projectPath: string) {
    await this.loadRuntimeState(projectPath)
    const issues = await this.store.readIssues(projectPath)
    const state = this.runtimeState.get(projectPath) ?? {}
    for (const issue of issues.filter((entry) => entry.status === 'in_progress')) {
      const current = state[issue.id]
      if (current?.claimed && current.phase === 'running' && current.sessionId && this.runtime.isRunning(current.sessionId)) continue
      state[issue.id] = createRuntimeState(issue.id, {
        claimed: false,
        phase: 'retry_waiting',
        nextRetryAt: new Date().toISOString(),
        lastError: current?.lastError ?? null,
      })
      this.retrying.set(`${projectPath}::${issue.id}`, {
        key: `${projectPath}::${issue.id}`,
        projectPath,
        issue,
        nextRetryAt: state[issue.id]!.nextRetryAt!,
      })
    }
    await this.persistRuntimeState(projectPath)
  }

  getSnapshot(): EngineSnapshot {
    return {
      sessions: {
        running: this.runtime.listRunning(),
      },
      issueRuns: {
        queued: Array.from(this.queued.values()).map((entry) => ({
          key: entry.key,
          projectPath: entry.projectPath,
          issueId: entry.issue.id,
          title: entry.issue.title,
          attempt: this.runtimeState.get(entry.projectPath)?.[entry.issue.id]?.attempt ?? 0,
          lastError: this.runtimeState.get(entry.projectPath)?.[entry.issue.id]?.lastError ?? null,
        })),
        running: Array.from(this.running.values()).map((entry) => {
          const state = this.runtimeState.get(entry.projectPath)?.[entry.issue.id]
          return {
            key: entry.key,
            projectPath: entry.projectPath,
            issueId: entry.issue.id,
            title: entry.issue.title,
            startedAt: entry.startedAt,
            attempt: state?.attempt ?? 0,
            sessionId: state?.sessionId ?? null,
            threadId: state?.threadId ?? null,
            turnId: state?.turnId ?? null,
            lastError: state?.lastError ?? null,
            tokenUsage: state?.tokenUsage ?? null,
          }
        }),
        retrying: Array.from(this.retrying.values()).map((entry) => {
          const state = this.runtimeState.get(entry.projectPath)?.[entry.issue.id]
          return {
            key: entry.key,
            projectPath: entry.projectPath,
            issueId: entry.issue.id,
            title: entry.issue.title,
            nextRetryAt: entry.nextRetryAt,
            attempt: state?.attempt ?? 0,
            lastError: state?.lastError ?? null,
            sessionId: state?.sessionId ?? null,
            threadId: state?.threadId ?? null,
            turnId: state?.turnId ?? null,
            tokenUsage: state?.tokenUsage ?? null,
          }
        }),
        maxConcurrent: Math.max(1, ...Array.from(this.runtimeState.keys()).map(() => 1)),
        claimedCount: Array.from(this.runtimeState.values())
          .flatMap((entry) => Object.values(entry))
          .filter((entry) => entry.claimed).length,
      },
    }
  }

  private async tick(projectPath: string) {
    const config = await this.readConfig(projectPath)
    if (!config.enabled) return

    await this.loadRuntimeState(projectPath)
    const issues = await this.store.readIssues(projectPath)
    await this.reconcileRunning(projectPath, issues)
    await this.releaseRetryReady(projectPath, issues)

    const activeRunning = Array.from(this.running.values()).filter((entry) => entry.projectPath === projectPath).length
    const available = Math.max(config.maxConcurrentRuns - activeRunning, 0)
    if (available <= 0) return

    const state = this.runtimeState.get(projectPath) ?? {}
    const candidates = issues.filter((issue) => issue.status === 'todo' && !state[issue.id]?.claimed)
    for (const issue of candidates.slice(0, available)) {
      await this.queueIssue(projectPath, issue)
      await this.runIssue(projectPath, issue)
    }
  }

  private async reconcileRunning(projectPath: string, issues: ProjectIssue[]) {
    const byId = new Map(issues.map((issue) => [issue.id, issue]))
    for (const run of Array.from(this.running.values()).filter((entry) => entry.projectPath === projectPath)) {
      const next = byId.get(run.issue.id)
      if (!next || next.status === 'backlog' || next.status === 'done') {
        const state = this.runtimeState.get(projectPath)?.[run.issue.id]
        if (state?.sessionId) this.runtime.cancel(state.sessionId)
        this.running.delete(run.key)
        await this.updateState(projectPath, run.issue.id, {
          claimed: false,
          phase: 'cancelled',
          lastError: null,
        })
      }
    }
  }

  private async releaseRetryReady(projectPath: string, issues: ProjectIssue[]) {
    const now = Date.now()
    const persisted = this.runtimeState.get(projectPath) ?? {}
    for (const issue of issues) {
      const state = persisted[issue.id]
      if (!state || state.phase !== 'retry_waiting' || !state.nextRetryAt) continue
      const key = `${projectPath}::${issue.id}`
      if (!this.retrying.has(key)) {
        this.retrying.set(key, {
          key,
          projectPath,
          issue,
          nextRetryAt: state.nextRetryAt,
        })
      }
    }

    for (const entry of Array.from(this.retrying.values()).filter((item) => item.projectPath === projectPath)) {
      if (new Date(entry.nextRetryAt).getTime() > now) continue
      this.retrying.delete(entry.key)
      const issue = issues.find((item) => item.id === entry.issue.id)
      if (!issue) continue
      await this.store.updateIssueStatus(projectPath, issue.id, 'todo')
      this.events.emit({ type: 'project.issuesChanged', projectPath })
      await this.updateState(projectPath, issue.id, {
        claimed: false,
        phase: 'idle',
        nextRetryAt: null,
      })
    }
  }

  private async queueIssue(projectPath: string, issue: ProjectIssue) {
    const key = `${projectPath}::${issue.id}`
    this.queued.set(key, { key, projectPath, issue })
    await this.store.updateIssueStatus(projectPath, issue.id, 'in_progress')
    this.events.emit({ type: 'project.issuesChanged', projectPath })
    await this.updateState(projectPath, issue.id, {
      claimed: true,
      phase: 'queued',
      attempt: (this.runtimeState.get(projectPath)?.[issue.id]?.attempt ?? 0) + 1,
      nextRetryAt: null,
      sessionId: issueSessionId(issue.id),
      updatedAt: new Date().toISOString(),
    })
  }

  private async runIssue(projectPath: string, issue: ProjectIssue) {
    const key = `${projectPath}::${issue.id}`
    this.queued.delete(key)
    this.running.set(key, { key, projectPath, issue, startedAt: new Date().toISOString() })
    await this.updateState(projectPath, issue.id, {
      phase: 'running',
      lastError: null,
    })

    const cfg = await this.store.readAgentConfig(projectPath)
    const settings = this.store.readAgentSettings(cfg)
    const dotagents = await this.store.readDotagentsConfig(projectPath)

    try {
      const hookResults = await this.hooks.run({
        projectPath,
        hooks: dotagents.hooks,
        event: 'before_run',
        agentKind: settings.kind,
      })
      await this.appendHookLogs(projectPath, issue.id, hookResults)
      for (const result of hookResults) {
        if (result.code !== 0) throw new Error(`before_run failed: ${result.command}`)
      }

      await this.store.appendIssueLog(projectPath, issue.id, {
        role: 'assistant',
        content: `Agent run started for "${issue.title}".`,
      })
      await this.store.writeTranscriptSource(projectPath, issueSessionId(issue.id), {
        agentKind: settings.kind,
        updatedAt: new Date().toISOString(),
      })

      const input: AgentRunInput = {
        agentKind: settings.kind,
        model: settings.model,
        thinking: settings.thinking,
        message: `Work on issue: ${issue.title}\n\n${issue.detail || ''}`,
        workspacePath: projectPath,
        sessionId: issueSessionId(issue.id),
        source: 'issue',
      }
      let assistantState = createAssistantMessageAccumulator()

      await this.runtime.start(input, {
        onOutput: (event) => {
          void this.store.writeTranscriptSource(projectPath, event.sessionId, {
            agentKind: settings.kind,
            threadId: event.threadId,
            turnId: event.turnId,
            path: event.path,
            updatedAt: new Date().toISOString(),
          })
          assistantState = appendAgentOutputEvent(assistantState, event)
          this.events.emit({ type: 'agent.output', data: event })
          void this.updateState(projectPath, issue.id, {
            sessionId: event.sessionId,
            threadId: event.threadId ?? this.runtimeState.get(projectPath)?.[issue.id]?.threadId ?? null,
            turnId: event.turnId ?? this.runtimeState.get(projectPath)?.[issue.id]?.turnId ?? null,
          })
        },
        onDone: async (event) => {
          if (hasAssistantMessageContent(assistantState) || event.error) {
            const message = finalizeAssistantMessage(assistantState, event.error)
            await this.store.appendIssueLog(projectPath, issue.id, {
              role: 'assistant',
              content: message.content,
              thinking: message.thinking,
              parts: message.parts,
              stream: message.stream,
            })
          }
          this.events.emit({ type: 'agent.done', data: event })
          this.running.delete(key)

          const afterRun = await this.hooks.run({
            projectPath,
            hooks: dotagents.hooks,
            event: 'after_run',
            agentKind: settings.kind,
          })
          await this.appendHookLogs(projectPath, issue.id, afterRun)

          if (event.exitCode === 0) {
            await this.store.updateIssueStatus(projectPath, issue.id, 'done')
            this.events.emit({ type: 'project.issuesChanged', projectPath })
            await this.updateState(projectPath, issue.id, {
              claimed: false,
              phase: 'completed',
              lastError: null,
              threadId: event.threadId ?? null,
              turnId: event.turnId ?? null,
              tokenUsage: event.tokenUsage ?? null,
            })
            return
          }

          await this.scheduleRetry(projectPath, issue, settings.kind, event.error ?? 'Agent run failed')
        },
      })
    } catch (error) {
      this.running.delete(key)
      await this.scheduleRetry(projectPath, issue, settings.kind, error instanceof Error ? error.message : String(error))
    }
  }

  private async scheduleRetry(projectPath: string, issue: ProjectIssue, agentKind: string, errorMessage: string) {
    const config = await this.readConfig(projectPath)
    const state = this.runtimeState.get(projectPath)?.[issue.id] ?? createRuntimeState(issue.id)
    const attempt = state.attempt
    const nextRetryAt = new Date(Date.now() + Math.min(config.retry.baseDelayMs * Math.max(1, 2 ** Math.max(attempt - 1, 0)), config.retry.maxDelayMs)).toISOString()

    const dotagents = await this.store.readDotagentsConfig(projectPath)
    const beforeRetry = await this.hooks.run({
      projectPath,
      hooks: dotagents.hooks,
      event: 'before_retry',
      agentKind,
    })
    await this.appendHookLogs(projectPath, issue.id, beforeRetry)

    if (attempt >= config.retry.maxAttempts) {
      await this.store.updateIssueStatus(projectPath, issue.id, 'todo')
      this.events.emit({ type: 'project.issuesChanged', projectPath })
      await this.updateState(projectPath, issue.id, {
        claimed: false,
        phase: 'failed',
        nextRetryAt: null,
        lastError: errorMessage,
      })
      return
    }

    await this.updateState(projectPath, issue.id, {
      claimed: true,
      phase: 'retry_waiting',
      nextRetryAt,
      lastError: errorMessage,
    })
    this.retrying.set(`${projectPath}::${issue.id}`, {
      key: `${projectPath}::${issue.id}`,
      projectPath,
      issue,
      nextRetryAt,
    })
  }

  private async appendHookLogs(projectPath: string, issueId: string, results: Array<{ command: string; code: number | null; stdout: string; stderr: string }>) {
    for (const result of results) {
      const lines = [
        `[hook] ${result.command}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        `exit: ${result.code ?? 'null'}`,
      ].filter(Boolean).join('\n')

      await this.store.appendIssueLog(projectPath, issueId, {
        role: 'assistant',
        content: lines,
        stream: result.code === 0 ? undefined : 'stderr',
      })
    }
  }

  private async readConfig(projectPath: string): Promise<IssueOrchestratorConfig> {
    const raw = await this.store.readAgentConfig(projectPath)
    return this.store.readPaiConfig(raw).orchestrator
  }

  private async loadRuntimeState(projectPath: string) {
    if (this.runtimeState.has(projectPath)) return
    this.runtimeState.set(projectPath, await this.store.readIssueRuntimeState(projectPath))
  }

  private async persistRuntimeState(projectPath: string) {
    await this.store.writeIssueRuntimeState(projectPath, this.runtimeState.get(projectPath) ?? {})
  }

  private async updateState(projectPath: string, issueId: string, patch: Partial<IssueRuntimeState>) {
    const current = this.runtimeState.get(projectPath) ?? {}
    current[issueId] = {
      ...createRuntimeState(issueId),
      ...(current[issueId] ?? {}),
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }
    this.runtimeState.set(projectPath, current)
    await this.persistRuntimeState(projectPath)
  }
}

function createRuntimeState(issueId: string, patch: Partial<IssueRuntimeState> = {}): IssueRuntimeState {
  return {
    issueId,
    claimed: false,
    phase: 'idle',
    attempt: 0,
    nextRetryAt: null,
    lastError: null,
    sessionId: null,
    threadId: null,
    turnId: null,
    tokenUsage: null,
    updatedAt: new Date().toISOString(),
    ...patch,
  }
}
