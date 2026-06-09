import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaiStore } from '../../../src/main/infra/fs/pai-store'
import { InternalWriteTracker } from '../../../src/main/infra/fs/internal-write-tracker'
import { orchestratorStatePath, paiConfigPath } from '../../../src/main/infra/fs/pai-paths'

const tempDirs: string[] = []

async function createProjectDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pai-store-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('PaiStore orchestrator config', () => {
  it('writes default issue orchestrator and codex app-server config into pai.toml', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())

    await store.inspectProjectFolder(projectPath)

    const raw = await readFile(paiConfigPath(projectPath), 'utf8')
    expect(raw).toContain('[issue_orchestrator]')
    expect(raw).toContain('enabled = true')
    expect(raw).toContain('poll_interval_ms = 2000')
    expect(raw).toContain('max_concurrent_runs = 1')
    expect(raw).toContain('[issue_orchestrator.retry]')
    expect(raw).toContain('max_attempts = 3')
    expect(raw).toContain('base_delay_ms = 5000')
    expect(raw).toContain('max_delay_ms = 60000')
    expect(raw).toContain('[codex_app_server]')
    expect(raw).toContain('enabled = true')
    expect(raw).toContain('turn_timeout_ms = 3600000')
  })

  it('reads typed orchestrator config with defaults when values are missing', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const config = await store.readAgentConfig(projectPath)

    expect(store.readPaiConfig(config)).toEqual({
      orchestrator: {
        enabled: true,
        pollIntervalMs: 2000,
        maxConcurrentRuns: 1,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 5000,
          maxDelayMs: 60000,
        },
      },
      codexAppServer: {
        enabled: true,
        turnTimeoutMs: 3600000,
      },
    })
  })
})

describe('PaiStore issue runtime state', () => {
  it('persists and reloads orchestrator runtime state', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())

    await store.writeIssueRuntimeState(projectPath, {
      'issue-1': {
        issueId: 'issue-1',
        claimed: true,
        phase: 'retry_waiting',
        attempt: 2,
        nextRetryAt: '2026-06-08T00:00:00.000Z',
        lastError: 'boom',
        sessionId: 'issue-1',
        threadId: 'thread-1',
        turnId: 'turn-2',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          cachedInputTokens: 3,
          totalTokens: 35,
        },
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    })

    const reloaded = await store.readIssueRuntimeState(projectPath)
    expect(reloaded).toEqual({
      'issue-1': {
        issueId: 'issue-1',
        claimed: true,
        phase: 'retry_waiting',
        attempt: 2,
        nextRetryAt: '2026-06-08T00:00:00.000Z',
        lastError: 'boom',
        sessionId: 'issue-1',
        threadId: 'thread-1',
        turnId: 'turn-2',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          cachedInputTokens: 3,
          totalTokens: 35,
        },
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    })

    const raw = await readFile(orchestratorStatePath(projectPath), 'utf8')
    expect(raw).toContain('"issue-1"')
    expect(raw).toContain('"phase": "retry_waiting"')
  })

  it('normalizes invalid runtime state payloads safely', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())

    await store.writeIssueRuntimeState(projectPath, {
      'issue-1': {
        issueId: 'issue-1',
        claimed: false,
        phase: 'idle',
        attempt: 0,
        nextRetryAt: null,
        lastError: null,
        sessionId: null,
        threadId: null,
        turnId: null,
        tokenUsage: null,
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    })

    const raw = await readFile(orchestratorStatePath(projectPath), 'utf8')
    await readFile(orchestratorStatePath(projectPath), 'utf8')
    expect(JSON.parse(raw)).toHaveProperty('issue-1')

    const reloaded = await store.readIssueRuntimeState(projectPath)
    expect(reloaded['issue-1']?.phase).toBe('idle')
    expect(reloaded['issue-1']?.attempt).toBe(0)
  })
})
