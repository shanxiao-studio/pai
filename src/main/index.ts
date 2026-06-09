import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { PaiApplication } from './application/pai-application'
import { IssueOrchestrator } from './application/issue-orchestrator'
import { AppEventBus } from './core/app-event-bus'
import { createMainWindow } from './electron/create-window'
import { bridgeAppEventsToElectron } from './electron/event-bridge'
import { registerIpcHandlers } from './electron/ipc-router'
import { CodexAppServerRuntime } from './infra/agents/codex-app-server-runtime'
import { CompositeAgentRuntime } from './infra/agents/composite-agent-runtime'
import { HookRunner } from './infra/agents/hook-runner'
import { AgentProcessRuntime } from './infra/agents/agent-process-runtime'
import { AgentRegistry } from './infra/agents/agent-registry'
import { FileWatchService } from './infra/fs/file-watch-service'
import { InternalWriteTracker } from './infra/fs/internal-write-tracker'
import { PaiStore } from './infra/fs/pai-store'

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const DIST = join(__dirname, '..')

const events = new AppEventBus()
const writeTracker = new InternalWriteTracker()
const store = new PaiStore(writeTracker)
const registry = new AgentRegistry()
const cliRuntime = new AgentProcessRuntime(registry)
const codexRuntime = new CodexAppServerRuntime()
const runtime = new CompositeAgentRuntime(cliRuntime, codexRuntime)
const hooks = new HookRunner()
const watches = new FileWatchService(events, writeTracker)
const orchestrator = new IssueOrchestrator(store, registry, runtime, hooks, events)
const pai = new PaiApplication(store, registry, runtime, watches, events, orchestrator)

registerIpcHandlers(pai)
bridgeAppEventsToElectron(events)

app.whenReady().then(() => {
  createMainWindow(DIST, VITE_DEV_SERVER_URL)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow(DIST, VITE_DEV_SERVER_URL)
  }
})
