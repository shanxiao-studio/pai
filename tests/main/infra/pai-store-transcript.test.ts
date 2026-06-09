import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaiStore } from '../../../src/main/infra/fs/pai-store'
import { InternalWriteTracker } from '../../../src/main/infra/fs/internal-write-tracker'
import { sessionDir, transcriptSourcePath } from '../../../src/main/infra/fs/pai-paths'

const tempDirs: string[] = []

async function createProjectDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pai-store-transcript-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('PaiStore transcript hydration', () => {
  it('backfills pi transcript history and prefers structured entries over legacy assistant summaries', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const sessionId = 'issue-1'
    const dir = sessionDir(projectPath, sessionId)
    const piDir = join(dir, 'pi-runtime')

    await mkdir(piDir, { recursive: true })
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ timestamp: '2026-06-09T03:36:34.000Z', role: 'user', content: 'hello' }),
      JSON.stringify({ timestamp: '2026-06-09T03:36:45.000Z', role: 'assistant', content: 'answer text' }),
    ].join('\n') + '\n', 'utf8')
    await writeFile(transcriptSourcePath(projectPath, sessionId), JSON.stringify({ agentKind: 'pi' }, null, 2))
    await writeFile(join(piDir, 'run.jsonl'), [
      JSON.stringify({ type: 'message', timestamp: '2026-06-09T03:36:35.000Z', message: { role: 'user', content: [{ type: 'text', text: 'internal prompt' }] } }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-09T03:36:45.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'answer text' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-09T03:36:46.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'tool output' }],
        },
      }),
    ].join('\n') + '\n', 'utf8')

    const logs = await store.readIssueLogs(projectPath, '1')
    const assistantLogs = logs.filter((entry) => entry.role === 'assistant')
    expect(assistantLogs).toHaveLength(1)
    expect(assistantLogs[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', text: 'plan' }),
      expect.objectContaining({ type: 'tool-call', name: 'read' }),
      expect.objectContaining({ type: 'tool-result', text: 'tool output' }),
    ]))
    expect(logs.some((entry) => entry.role === 'user' && entry.content === 'internal prompt')).toBe(false)
  })

  it('writes transcript source metadata to disk', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())

    await store.writeTranscriptSource(projectPath, 'session-1', {
      agentKind: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-1',
      path: '/tmp/codex-session.jsonl',
      updatedAt: '2026-06-09T12:00:00.000Z',
    })

    const raw = await readFile(transcriptSourcePath(projectPath, 'session-1'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      agentKind: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-1',
      path: '/tmp/codex-session.jsonl',
    })
  })

  it('keeps assistant chat messages whose text contains the user prompt', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const dir = sessionDir(projectPath, 'default')

    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-09T09:45:36.682Z',
        role: 'user',
        content: '你好',
        parts: [{ type: 'text', text: '你好' }],
      }),
      JSON.stringify({
        timestamp: '2026-06-09T09:45:40.809Z',
        role: 'assistant',
        content: '你好！有什么想聊的？',
        parts: [
          { type: 'thinking', text: 'reply warmly', state: 'done' },
          { type: 'text', text: '你好！有什么想聊的？' },
        ],
      }),
    ].join('\n') + '\n', 'utf8')

    const logs = await store.readChatLogs(projectPath, 'default')

    expect(logs.map((entry) => entry.role)).toEqual(['user', 'assistant'])
    expect(logs[1]).toMatchObject({
      role: 'assistant',
      content: '你好！有什么想聊的？',
    })
  })

  it('hydrates missing assistant thinking from pi transcript history', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const dir = sessionDir(projectPath, 'default')
    const piDir = join(dir, 'pi-runtime')

    await mkdir(piDir, { recursive: true })
    await writeFile(join(dir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-09T10:12:28.669Z',
        role: 'user',
        content: '这个项目主要是干什么的',
        parts: [{ type: 'text', text: '这个项目主要是干什么的' }],
      }),
      JSON.stringify({
        timestamp: '2026-06-09T10:12:37.271Z',
        role: 'assistant',
        content: 'answer from transcript',
        parts: [{ type: 'text', text: 'answer from transcript' }],
      }),
    ].join('\n') + '\n', 'utf8')
    await writeFile(transcriptSourcePath(projectPath, 'default'), JSON.stringify({ agentKind: 'pi' }, null, 2))
    await writeFile(join(piDir, 'run.jsonl'), [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-09T10:12:37.238Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning from transcript' },
            { type: 'text', text: 'answer from transcript' },
          ],
        },
      }),
    ].join('\n') + '\n', 'utf8')

    const logs = await store.readChatLogs(projectPath, 'default')
    const assistant = logs.find((entry) => entry.role === 'assistant')

    expect(assistant?.thinking).toContain('reasoning from transcript')
    expect(assistant?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', text: 'reasoning from transcript' }),
      expect.objectContaining({ type: 'text', text: 'answer from transcript' }),
    ]))
  })

  it('does not expose transcript messages that are not backed by messages jsonl', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const dir = sessionDir(projectPath, 'default')
    const piDir = join(dir, 'pi-runtime')

    await mkdir(piDir, { recursive: true })
    await writeFile(join(dir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-09T10:20:35.011Z',
        role: 'user',
        content: '有哪些可以进一步的修改？',
        parts: [{ type: 'text', text: '有哪些可以进一步的修改？' }],
      }),
      JSON.stringify({
        timestamp: '2026-06-09T10:21:23.143Z',
        role: 'assistant',
        content: '最终回复',
        parts: [{ type: 'text', text: '最终回复' }],
      }),
    ].join('\n') + '\n', 'utf8')
    await writeFile(transcriptSourcePath(projectPath, 'default'), JSON.stringify({ agentKind: 'pi' }, null, 2))
    await writeFile(join(piDir, 'run.jsonl'), [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-09T10:20:46.068Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'intermediate thought' },
            { type: 'text', text: '让我先看看各组件的实现状态。' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-09T10:21:23.066Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'final thought' },
            { type: 'text', text: '最终回复' },
          ],
        },
      }),
    ].join('\n') + '\n', 'utf8')

    const logs = await store.readChatLogs(projectPath, 'default')

    expect(logs.map((entry) => entry.content)).toEqual(['有哪些可以进一步的修改？', '最终回复'])
    expect(logs.filter((entry) => entry.role === 'assistant')).toHaveLength(1)
    expect(logs.some((entry) => entry.content === '让我先看看各组件的实现状态。')).toBe(false)
  })

  it('normalizes duplicated assistant transcript snapshots from persisted chat logs', async () => {
    const projectPath = await createProjectDir()
    const store = new PaiStore(new InternalWriteTracker())
    const dir = sessionDir(projectPath, 'default')

    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-09T10:21:23.143Z',
        role: 'assistant',
        content: 'firstfirstsecond',
        stream: 'stderr',
        parts: [
          { type: 'log', stream: 'stderr', text: 'warning' },
          { type: 'thinking', text: 'plan', state: 'done' },
          { type: 'text', text: 'first' },
          { type: 'log', stream: 'stderr', text: 'warning' },
          { type: 'thinking', text: 'plan', state: 'done' },
          { type: 'text', text: 'first' },
          { type: 'tool-call', id: 'tool-1', name: 'read', state: 'done' },
          { type: 'text', text: 'second' },
        ],
      }),
    ].join('\n') + '\n', 'utf8')

    const logs = await store.readChatLogs(projectPath, 'default')
    const assistant = logs.find((entry) => entry.role === 'assistant')

    expect(assistant?.stream).toBeUndefined()
    expect(assistant?.content).toBe('firstsecond')
    expect(assistant?.parts).toEqual([
      { type: 'log', stream: 'stderr', text: 'warning' },
      { type: 'thinking', text: 'plan', state: 'done' },
      { type: 'text', text: 'first' },
      { type: 'tool-call', id: 'tool-1', name: 'read', state: 'done' },
      { type: 'text', text: 'second' },
    ])
  })
})
