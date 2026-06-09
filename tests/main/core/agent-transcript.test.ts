import { describe, expect, it } from 'vitest'
import { assembleTranscriptMessages, readClaudeTranscriptFrames, readCodexTranscriptFrames, readPiTranscriptFrames } from '../../../src/main/core/agent-transcript'

describe('agent transcript adapters', () => {
  it('maps pi assistant and tool-result records into structured assistant messages', () => {
    const frames = [
      ...readPiTranscriptFrames({
        type: 'message',
        timestamp: '2026-06-09T03:36:35.098Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'raw prompt' }],
        },
      }),
      ...readPiTranscriptFrames({
        type: 'message',
        timestamp: '2026-06-09T03:36:41.565Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking text' },
            { type: 'text', text: 'answer text' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
      }),
      ...readPiTranscriptFrames({
        type: 'message',
        timestamp: '2026-06-09T03:36:43.506Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'tool output' }],
          isError: false,
        },
      }),
    ]

    const messages = assembleTranscriptMessages(frames, { agentKind: 'pi' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toContain('answer text')
    expect(messages[0]?.thinking).toContain('thinking text')
    expect(messages[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', name: 'read' }),
      expect.objectContaining({ type: 'tool-result', name: 'read', text: 'tool output' }),
    ]))
  })

  it('maps claude assistant tool_use and user tool_result without surfacing raw user prompts', () => {
    const frames = [
      ...readClaudeTranscriptFrames({
        type: 'user',
        timestamp: '2026-05-23T15:32:45.332Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'internal raw prompt' }],
        },
      }),
      ...readClaudeTranscriptFrames({
        type: 'assistant',
        timestamp: '2026-05-23T15:32:47.246Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'claude thinking' },
            { type: 'text', text: 'let me explore' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      ...readClaudeTranscriptFrames({
        type: 'user',
        timestamp: '2026-05-23T15:32:48.558Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'listing output' }],
        },
      }),
    ]

    const messages = assembleTranscriptMessages(frames, { agentKind: 'claude' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toContain('let me explore')
    expect(messages[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', id: 'tool-1', name: 'Bash' }),
      expect.objectContaining({ type: 'tool-result', id: 'tool-1', text: 'listing output' }),
    ]))
  })

  it('maps codex response items and ignores raw user transcript messages', () => {
    const frames = [
      ...readCodexTranscriptFrames({
        type: 'response_item',
        timestamp: '2026-04-29T15:36:06.328Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'internal prompt' }],
        },
      }),
      ...readCodexTranscriptFrames({
        type: 'response_item',
        timestamp: '2026-04-29T15:36:10.154Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'reasoning_text', text: 'codex thinking' },
            { type: 'output_text', text: 'codex answer' },
          ],
        },
      }),
      ...readCodexTranscriptFrames({
        type: 'response_item',
        timestamp: '2026-04-29T15:36:10.200Z',
        payload: {
          type: 'function_call',
          id: 'call-1',
          name: 'exec',
          arguments: { cmd: 'pwd' },
        },
      }),
      ...readCodexTranscriptFrames({
        type: 'response_item',
        timestamp: '2026-04-29T15:36:10.300Z',
        payload: {
          type: 'function_call_output',
          id: 'call-1',
          name: 'exec',
          output_text: '/tmp/project',
        },
      }),
    ]

    const messages = assembleTranscriptMessages(frames, { agentKind: 'codex', threadId: 'thread-1', turnId: 'turn-1' })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      content: 'codex answer',
      thinking: 'codex thinking\n',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    expect(messages[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', id: 'call-1' }),
      expect.objectContaining({ type: 'tool-result', id: 'call-1', text: '/tmp/project' }),
    ]))
  })
})
