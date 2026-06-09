import { describe, expect, it, vi } from 'vitest'
import { IssueOrchestrator } from '../../../src/main/application/issue-orchestrator'
import { AppEventBus, PaiAppEvent } from '../../../src/main/core/app-event-bus'
import { ProjectIssue } from '../../../src/main/core/models'
import { AgentRegistry } from '../../../src/main/infra/agents/agent-registry'
import { AgentRuntime, AgentRunHooks } from '../../../src/main/infra/agents/agent-runtime'
import { HookRunner } from '../../../src/main/infra/agents/hook-runner'
import { PaiStore } from '../../../src/main/infra/fs/pai-store'

function createIssue(id: string, status = 'todo'): ProjectIssue {
  return {
    id,
    title: `Issue ${id}`,
    status,
    priority: 'medium',
    labels: ['core'],
    detail: `Detail ${id}`,
    attributes: {},
  }
}

function createHarness(options: {
  issues?: ProjectIssue[]
  runtimeState?: Record<string, unknown>
  hookResults?: Array<{ command: string; code: number | null; stdout: string; stderr: string }>
} = {}) {
  const emitted: PaiAppEvent[] = []
  const events = new AppEventBus()
  events.subscribe((event) => emitted.push(event))

  let issues = options.issues ?? [createIssue('1')]
  let runtimeState = options.runtimeState ?? {}
  const store = {
    readIssues: vi.fn(async () => issues),
    readIssueRuntimeState: vi.fn(async () => runtimeState),
    writeIssueRuntimeState: vi.fn(async (_projectPath: string, next: Record<string, unknown>) => {
      runtimeState = next
    }),
    updateIssueStatus: vi.fn(async (_projectPath: string, issueId: string, status: string) => {
      issues = issues.map((issue) => issue.id === issueId ? { ...issue, status } : issue)
    }),
    readAgentConfig: vi.fn(async () => ({
      agents: { default: 'codex', codex: { model: 'gpt-5', thinking: 'medium' } },
      issue_orchestrator: {
        enabled: true,
        poll_interval_ms: 2000,
        max_concurrent_runs: 1,
        retry: { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 5 },
      },
      codex_app_server: { enabled: true, turn_timeout_ms: 3600000 },
    })),
    readPaiConfig: vi.fn((config: Record<string, unknown>) => ({
      orchestrator: {
        enabled: true,
        pollIntervalMs: 2000,
        maxConcurrentRuns: 1,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      },
      codexAppServer: {
        enabled: true,
        turnTimeoutMs: 3600000,
      },
      ...config,
    })),
    readAgentSettings: vi.fn(() => ({ kind: 'codex', model: 'gpt-5', thinking: 'medium' })),
    readDotagentsConfig: vi.fn(async () => ({ version: 1, gitignore: true, agents: [], skills: [], mcp: [], hooks: [], exists: false })),
    appendIssueLog: vi.fn(async () => undefined),
    writeTranscriptSource: vi.fn(async () => undefined),
  }

  const startCalls: Array<{ hooks?: AgentRunHooks }> = []
  const runtime: AgentRuntime = {
    isRunning: vi.fn(() => false),
    listRunning: vi.fn(() => []),
    cancel: vi.fn(() => true),
    start: vi.fn(async (_input, hooks) => {
      startCalls.push({ hooks })
      return { sessionId: 'issue-1' }
    }),
  }

  const registry = {
    detectAgents: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
  }

  const hooks = {
    run: vi.fn(async () => options.hookResults ?? []),
  }

  const orchestrator = new IssueOrchestrator(
    store as unknown as PaiStore,
    registry as unknown as AgentRegistry,
    runtime,
    hooks as unknown as HookRunner,
    events,
  )

  return { orchestrator, store, runtime, hooks, emitted, startCalls, getIssues: () => issues, getRuntimeState: () => runtimeState }
}

describe('IssueOrchestrator', () => {
  it('claims todo issues, starts runtime, and marks success done', async () => {
    const { orchestrator, store, startCalls, getIssues, getRuntimeState, emitted } = createHarness({
      issues: [createIssue('1', 'todo')],
    })

    await orchestrator.onProjectIssuesChanged('/project')
    expect(store.updateIssueStatus).toHaveBeenCalledWith('/project', '1', 'in_progress')
    expect(startCalls).toHaveLength(1)
    expect(orchestrator.getSnapshot().issueRuns.running).toHaveLength(1)

    await startCalls[0]!.hooks?.onDone?.({ sessionId: 'issue-1', exitCode: 0, threadId: 'thread-1', turnId: 'turn-1' })

    expect(getIssues()[0]?.status).toBe('done')
    expect(getRuntimeState()).toMatchObject({
      '1': {
        claimed: false,
        phase: 'completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })
    expect(emitted).toContainEqual({ type: 'project.issuesChanged', projectPath: '/project' })
  })

  it('moves failed runs into retry_waiting and exposes retry snapshot', async () => {
    const { orchestrator, startCalls, getRuntimeState } = createHarness({
      issues: [createIssue('1', 'todo')],
    })

    await orchestrator.onProjectIssuesChanged('/project')
    await startCalls[0]!.hooks?.onDone?.({ sessionId: 'issue-1', exitCode: 1, error: 'boom' })

    expect(getRuntimeState()).toMatchObject({
      '1': {
        claimed: true,
        phase: 'retry_waiting',
        lastError: 'boom',
      },
    })
    expect(orchestrator.getSnapshot().issueRuns.retrying).toHaveLength(1)
  })

  it('returns issues to todo after max retry attempts are exceeded', async () => {
    const { orchestrator, startCalls, getIssues, getRuntimeState } = createHarness({
      issues: [createIssue('1', 'todo')],
      runtimeState: {
        '1': {
          issueId: '1',
          claimed: false,
          phase: 'idle',
          attempt: 3,
          nextRetryAt: null,
          lastError: null,
          sessionId: null,
          threadId: null,
          turnId: null,
          tokenUsage: null,
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      },
    })

    await orchestrator.onProjectIssuesChanged('/project')
    await startCalls[0]!.hooks?.onDone?.({ sessionId: 'issue-1', exitCode: 1, error: 'fatal' })

    expect(getIssues()[0]?.status).toBe('todo')
    expect(getRuntimeState()).toMatchObject({
      '1': {
        claimed: false,
        phase: 'failed',
        lastError: 'fatal',
      },
    })
  })

  it('restores in_progress issues as retry_waiting during hydration', async () => {
    const { orchestrator, getRuntimeState } = createHarness({
      issues: [createIssue('1', 'in_progress')],
    })

    await orchestrator.hydrateProject('/project')

    expect(getRuntimeState()).toMatchObject({
      '1': {
        claimed: false,
        phase: 'retry_waiting',
      },
    })
    expect(orchestrator.getSnapshot().issueRuns.retrying).toHaveLength(1)
  })

  it('treats before_run hook failures as retryable failures', async () => {
    const { orchestrator, hooks, runtime, getRuntimeState } = createHarness({
      issues: [createIssue('1', 'todo')],
      hookResults: [{ command: 'exit 1', code: 1, stdout: '', stderr: 'nope' }],
    })

    await orchestrator.onProjectIssuesChanged('/project')

    expect(hooks.run).toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(getRuntimeState()).toMatchObject({
      '1': {
        phase: 'retry_waiting',
      },
    })
  })

  it('releases retry_waiting issues back to todo when retry time is reached', async () => {
    const { orchestrator, store, getIssues } = createHarness({
      issues: [createIssue('1', 'in_progress')],
      runtimeState: {
        '1': {
          issueId: '1',
          claimed: true,
          phase: 'retry_waiting',
          attempt: 1,
          nextRetryAt: new Date(Date.now() - 1000).toISOString(),
          lastError: 'boom',
          sessionId: 'issue-1',
          threadId: null,
          turnId: null,
          tokenUsage: null,
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      },
    })

    await orchestrator.onProjectIssuesChanged('/project')

    expect(store.updateIssueStatus).toHaveBeenCalledWith('/project', '1', 'todo')
    expect(getIssues()[0]?.status).toBe('todo')
  })
})
