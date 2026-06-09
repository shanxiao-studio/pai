import { BrowserWindow } from 'electron'
import { AppEventBus, PaiAppEvent } from '../core/app-event-bus'

export function bridgeAppEventsToElectron(events: AppEventBus) {
  return events.subscribe((event) => {
    const { channel, payload } = toIpcEvent(event)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  })
}

function toIpcEvent(event: PaiAppEvent) {
  switch (event.type) {
    case 'workspace.changed':
      return { channel: 'workspace:changed', payload: { workspacePath: event.workspacePath } }
    case 'project.changed':
      return { channel: 'project:changed', payload: { projectPath: event.projectPath } }
    case 'project.issuesChanged':
      return { channel: 'project:issuesChanged', payload: { projectPath: event.projectPath } }
    case 'agent.output':
      return { channel: 'agent:output', payload: event.data }
    case 'agent.done':
      return { channel: 'agent:done', payload: event.data }
  }
}
