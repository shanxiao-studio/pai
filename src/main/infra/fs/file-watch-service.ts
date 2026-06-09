import type { WebContents } from 'electron'
import { FSWatcher, watch } from 'fs'
import { join, resolve } from 'path'
import { AppEventBus } from '../../core/app-event-bus'
import { InternalWriteTracker } from './internal-write-tracker'

type WatchScope = 'workspace' | 'project'

type WatchSubscription = {
  id: string
  scope: WatchScope
  rootPath: string
  sender: WebContents
  watchers: FSWatcher[]
  timers: NodeJS.Timeout[]
}

export class FileWatchService {
  private subscriptions = new Map<string, WatchSubscription>()

  constructor(
    private readonly events: AppEventBus,
    private readonly writeTracker: InternalWriteTracker,
  ) {}

  watchWorkspace(sender: WebContents, workspacePath: string) {
    return this.createFileWatch(sender, 'workspace', workspacePath)
  }

  watchProject(sender: WebContents, projectPath: string) {
    return this.createFileWatch(sender, 'project', projectPath)
  }

  unwatch(id: string) {
    const subscription = this.subscriptions.get(id)
    if (!subscription) return

    for (const timer of subscription.timers) clearTimeout(timer)
    for (const watcher of subscription.watchers) watcher.close()
    this.subscriptions.delete(id)
  }

  private createFileWatch(sender: WebContents, scope: WatchScope, rootPath: string) {
    const id = `${scope}:${rootPath}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const watchers: FSWatcher[] = []
    const timers: NodeJS.Timeout[] = []
    const root = resolve(rootPath)

    const emitChange = debounceWatchEvent(timers, () => {
      if (sender.isDestroyed()) return
      if (scope === 'workspace') {
        this.events.emit({ type: 'workspace.changed', workspacePath: rootPath })
      } else {
        this.events.emit({ type: 'project.changed', projectPath: rootPath })
      }
    })

    const addWatcher = (dirPath: string, recursive = false) => {
      try {
        const watcher = watch(dirPath, { persistent: false, recursive }, (_eventType, filename) => {
          const changedPath = filename ? join(dirPath, String(filename)) : dirPath
          if (!isWatchedPath(scope, root, changedPath)) return
          if (this.writeTracker.isInternal(changedPath)) return
          emitChange()
        })
        watcher.on('error', () => this.unwatch(id))
        watchers.push(watcher)
      } catch {
        // Optional .pai directories may not exist yet.
      }
    }

    if (scope === 'workspace') {
      addWatcher(root)
      addWatcher(join(root, '.pai'))
    } else {
      addWatcher(root)
      addWatcher(join(root, '.pai'), true)
    }

    this.subscriptions.set(id, { id, scope, rootPath, sender, watchers, timers })
    sender.once('destroyed', () => this.unwatch(id))
    return id
  }
}

function debounceWatchEvent(timers: NodeJS.Timeout[], callback: () => void) {
  return () => {
    const previous = timers.pop()
    if (previous) clearTimeout(previous)
    const timer = setTimeout(callback, 120)
    timers.push(timer)
  }
}

function isWatchedPath(scope: WatchScope, rootPath: string, changedPath: string) {
  const path = resolve(changedPath)
  const relative = path.startsWith(rootPath) ? path.slice(rootPath.length + 1) : path
  if (scope === 'workspace') {
    return relative === 'AGENTS.md' || relative === join('.pai', 'pai.toml')
  }

  return (
    relative === 'AGENTS.md' ||
    relative === join('.pai', 'pai.toml') ||
    relative === join('.pai', 'agents.toml') ||
    relative.startsWith(join('.pai', 'threads')) ||
    relative.startsWith(join('.pai', 'sessions'))
  )
}
