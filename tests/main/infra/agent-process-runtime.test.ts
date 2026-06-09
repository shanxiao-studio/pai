import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentOutputEvent } from '../../../src/main/core/models'
import { AgentProcessRuntime } from '../../../src/main/infra/agents/agent-process-runtime'
import { AgentRegistry } from '../../../src/main/infra/agents/agent-registry'
import { sessionDir } from '../../../src/main/infra/fs/pai-paths'

const tempDirs: string[] = []

async function createProjectDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pai-agent-runtime-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AgentProcessRuntime transcript replay', () => {
  it('emits only newly appended parts when a structured transcript message grows', async () => {
    const projectPath = await createProjectDir()
    const binPath = join(projectPath, 'fake-pi.sh')
    const piRuntimeDir = join(sessionDir(projectPath, 'default'), 'pi-runtime')
    const transcriptPath = join(piRuntimeDir, 'run.jsonl')
    const outputEvents: AgentOutputEvent[] = []
    const registry = {
      resolveCommand: vi.fn(async () => binPath),
    } as unknown as AgentRegistry
    const runtime = new AgentProcessRuntime(registry)

    await mkdir(piRuntimeDir, { recursive: true })
    await writeFile(binPath, [
      '#!/bin/sh',
      'printf "%s\\n" \'{"type":"message","timestamp":"2099-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}\' > "$PWD/.pai/sessions/default/pi-runtime/run.jsonl"',
      'sleep 1',
      'printf "%s\\n" \'{"type":"message","timestamp":"2099-01-01T00:00:01.000Z","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"read","content":[{"type":"text","text":"tool output"}]}}\' >> "$PWD/.pai/sessions/default/pi-runtime/run.jsonl"',
    ].join('\n'), 'utf8')
    await chmod(binPath, 0o755)
    await writeFile(transcriptPath, '', 'utf8')

    await new Promise<void>(async (resolve, reject) => {
      try {
        await runtime.start({
          agentKind: 'pi',
          model: '',
          thinking: 'medium',
          message: 'hello',
          workspacePath: projectPath,
          sessionId: 'default',
        }, {
          onOutput: (event) => outputEvents.push(event),
          onDone: () => resolve(),
        })
      } catch (error) {
        reject(error)
      }
    })

    expect(outputEvents).toHaveLength(2)
    expect(outputEvents.map((event) => event.parts)).toEqual([
      [{ type: 'text', text: 'first' }],
      [expect.objectContaining({ type: 'tool-result', text: 'tool output' })],
    ])
  })

  it('flushes pi transcript output when the process exits quickly', async () => {
    const projectPath = await createProjectDir()
    const binPath = join(projectPath, 'fake-pi.sh')
    const piRuntimeDir = join(sessionDir(projectPath, 'default'), 'pi-runtime')
    const transcriptPath = join(piRuntimeDir, 'run.jsonl')
    const outputEvents: AgentOutputEvent[] = []
    const registry = {
      resolveCommand: vi.fn(async () => binPath),
    } as unknown as AgentRegistry
    const runtime = new AgentProcessRuntime(registry)

    await mkdir(piRuntimeDir, { recursive: true })
    await writeFile(binPath, '#!/bin/sh\necho "plain stdout fallback"\n', 'utf8')
    await chmod(binPath, 0o755)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: 'message',
        timestamp: '2099-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning from transcript' },
            { type: 'text', text: 'answer from transcript' },
          ],
        },
      }),
    ].join('\n') + '\n', 'utf8')

    await new Promise<void>(async (resolve, reject) => {
      try {
        await runtime.start({
          agentKind: 'pi',
          model: '',
          thinking: 'medium',
          message: 'hello',
          workspacePath: projectPath,
          sessionId: 'default',
        }, {
          onOutput: (event) => outputEvents.push(event),
          onDone: () => resolve(),
        })
      } catch (error) {
        reject(error)
      }
    })

    expect(outputEvents).toHaveLength(1)
    expect(outputEvents[0]?.text).toBe('answer from transcript')
    expect(outputEvents[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', text: 'reasoning from transcript' }),
      expect.objectContaining({ type: 'text', text: 'answer from transcript' }),
    ]))
  })
})
