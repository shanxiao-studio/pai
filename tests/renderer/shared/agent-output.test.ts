import { describe, expect, it } from 'vitest'
import { shouldKeepWaitingForAssistantMessage, type PendingAssistantRun } from '../../../src/renderer/shared/agent-output'
import type { ChatMessage } from '../../../src/renderer/components/chat/MessageSurface'

function createPendingRun(overrides: Partial<PendingAssistantRun> = {}): PendingAssistantRun {
  return {
    assistantMessagesBeforeRun: 1,
    startedAt: 1_000,
    graceMs: 5_000,
    ...overrides,
  }
}

function createAssistantMessage(content: string): ChatMessage {
  return {
    id: content,
    role: 'assistant',
    content,
    parts: [{ type: 'text', text: content }],
  }
}

describe('shouldKeepWaitingForAssistantMessage', () => {
  it('keeps waiting while no new assistant message is visible within the grace window', () => {
    const pendingRun = createPendingRun()
    const messages = [createAssistantMessage('existing reply')]

    expect(shouldKeepWaitingForAssistantMessage(messages, pendingRun, 4_000)).toBe(true)
  })

  it('stops waiting once a new assistant message has been loaded', () => {
    const pendingRun = createPendingRun()
    const messages = [
      createAssistantMessage('existing reply'),
      createAssistantMessage('new reply'),
    ]

    expect(shouldKeepWaitingForAssistantMessage(messages, pendingRun, 4_000)).toBe(false)
  })

  it('stops waiting after the grace window expires', () => {
    const pendingRun = createPendingRun()
    const messages = [createAssistantMessage('existing reply')]

    expect(shouldKeepWaitingForAssistantMessage(messages, pendingRun, 6_100)).toBe(false)
  })
})
