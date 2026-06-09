import { describe, expect, it } from 'vitest'
import { appendAgentOutputEvent, createAssistantMessageAccumulator, finalizeAssistantMessage } from '../../../src/main/core/agent-output-aggregation'

describe('agent output aggregation', () => {
  it('does not duplicate structured transcript snapshots that grow over time', () => {
    let state = createAssistantMessageAccumulator()

    state = appendAgentOutputEvent(state, {
      sessionId: 'chat-1',
      text: 'first',
      parts: [
        { type: 'thinking', text: 'plan', state: 'done' },
        { type: 'text', text: 'first' },
      ],
    })
    state = appendAgentOutputEvent(state, {
      sessionId: 'chat-1',
      text: 'firstsecond',
      parts: [
        { type: 'thinking', text: 'plan', state: 'done' },
        { type: 'text', text: 'first' },
        { type: 'tool-call', id: 'tool-1', name: 'read', state: 'done' },
        { type: 'text', text: 'second' },
      ],
    })

    const message = finalizeAssistantMessage(state)

    expect(message.content).toBe('second')
    expect(message.thinking).toBe('plan')
    expect(message.parts).toEqual([
      { type: 'thinking', text: 'plan', state: 'done' },
      { type: 'text', text: 'first' },
      { type: 'tool-call', id: 'tool-1', name: 'read', state: 'done' },
      { type: 'text', text: 'second' },
    ])
  })

  it('uses the final text part as the persisted assistant content', () => {
    let state = createAssistantMessageAccumulator()

    state = appendAgentOutputEvent(state, {
      sessionId: 'chat-1',
      text: '',
      parts: [
        { type: 'thinking', text: 'plan', state: 'streaming' },
        { type: 'text', text: 'Let me inspect the project.' },
        { type: 'tool-call', id: 'tool-1', name: 'read', state: 'running' },
        { type: 'tool-result', id: 'tool-1', name: 'read', text: 'file contents' },
        { type: 'text', text: 'Final answer.' },
      ],
    })

    const message = finalizeAssistantMessage(state)

    expect(message.content).toBe('Final answer.')
    expect(message.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', state: 'done' }),
      expect.objectContaining({ type: 'tool-call', state: 'done' }),
      expect.objectContaining({ type: 'tool-result', text: 'file contents' }),
      expect.objectContaining({ type: 'text', text: 'Final answer.' }),
    ]))
  })

  it('keeps stderr as a log part without marking normal assistant output as stderr', () => {
    let state = createAssistantMessageAccumulator()

    state = appendAgentOutputEvent(state, {
      sessionId: 'chat-1',
      text: 'warning',
      stream: 'stderr',
    })
    state = appendAgentOutputEvent(state, {
      sessionId: 'chat-1',
      text: 'answer',
      parts: [{ type: 'text', text: 'answer' }],
    })

    const message = finalizeAssistantMessage(state)

    expect(message.stream).toBeUndefined()
    expect(message.content).toBe('answer')
    expect(message.parts).toEqual([
      { type: 'log', stream: 'stderr', text: 'warning' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('finalizes tool-only output with visible fallback content and preserved parts', () => {
    const state = appendAgentOutputEvent(createAssistantMessageAccumulator(), {
      sessionId: 'chat-1',
      text: '',
      parts: [
        { type: 'tool-call', id: 'tool-1', name: 'read', args: { path: 'a.ts' }, state: 'running' },
      ],
    })

    const message = finalizeAssistantMessage(state)

    expect(message.content).toBe('No output')
    expect(message.parts).toEqual([
      expect.objectContaining({ type: 'tool-call', id: 'tool-1', state: 'done' }),
    ])
  })
})
