import type { AgentDoneEvent, AgentOutputEvent } from './models'

export type PaiAppEvent =
  | { type: 'workspace.changed'; workspacePath: string }
  | { type: 'project.changed'; projectPath: string }
  | { type: 'project.issuesChanged'; projectPath: string }
  | { type: 'agent.output'; data: AgentOutputEvent }
  | { type: 'agent.done'; data: AgentDoneEvent }

export type PaiAppEventHandler = (event: PaiAppEvent) => void

export class AppEventBus {
  private handlers = new Set<PaiAppEventHandler>()

  subscribe(handler: PaiAppEventHandler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(event: PaiAppEvent) {
    for (const handler of this.handlers) {
      handler(event)
    }
  }
}
