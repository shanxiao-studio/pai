import { AgentRunInput } from '../../core/models'
import { AgentRunHooks, AgentRuntime } from './agent-runtime'

export class CompositeAgentRuntime implements AgentRuntime {
  constructor(
    private readonly defaultRuntime: AgentRuntime,
    private readonly codexRuntime: AgentRuntime,
  ) {}

  isRunning(sessionId: string) {
    return this.defaultRuntime.isRunning(sessionId) || this.codexRuntime.isRunning(sessionId)
  }

  listRunning() {
    return Array.from(new Set([
      ...this.defaultRuntime.listRunning(),
      ...this.codexRuntime.listRunning(),
    ]))
  }

  cancel(sessionId: string) {
    return this.codexRuntime.cancel(sessionId) || this.defaultRuntime.cancel(sessionId)
  }

  start(input: AgentRunInput, hooks: AgentRunHooks = {}) {
    if (input.agentKind === 'codex') return this.codexRuntime.start(input, hooks)
    return this.defaultRuntime.start(input, hooks)
  }
}
