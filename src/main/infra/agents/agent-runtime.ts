import { AgentDoneEvent, AgentOutputEvent, AgentRunInput } from '../../core/models'

export type AgentRunHooks = {
  onOutput?: (event: AgentOutputEvent) => void
  onDone?: (event: AgentDoneEvent) => void | Promise<void>
}

export type AgentRuntime = {
  isRunning(sessionId: string): boolean
  listRunning(): string[]
  cancel(sessionId: string): boolean
  start(input: AgentRunInput, hooks?: AgentRunHooks): Promise<{ sessionId: string }>
}
