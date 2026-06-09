import { describe, expect, it, vi } from 'vitest'
import { AppEventBus, PaiAppEvent } from '../../../src/main/core/app-event-bus'

describe('AppEventBus', () => {
  it('emits events to every subscribed handler', () => {
    const bus = new AppEventBus()
    const first = vi.fn()
    const second = vi.fn()
    const event: PaiAppEvent = { type: 'workspace.changed', workspacePath: '/workspace' }

    bus.subscribe(first)
    bus.subscribe(second)
    bus.emit(event)

    expect(first).toHaveBeenCalledWith(event)
    expect(second).toHaveBeenCalledWith(event)
  })

  it('removes handlers when the unsubscribe callback is called', () => {
    const bus = new AppEventBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe(handler)

    unsubscribe()
    bus.emit({ type: 'project.changed', projectPath: '/project' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps duplicate subscriptions idempotent', () => {
    const bus = new AppEventBus()
    const handler = vi.fn()

    bus.subscribe(handler)
    bus.subscribe(handler)
    bus.emit({ type: 'agent.done', data: { sessionId: 'session-1', exitCode: 0 } })

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
