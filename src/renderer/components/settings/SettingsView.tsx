import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useWorkspaces } from '@/components/workspace/WorkspaceProvider'
import type { GlobalSettings, ThemePreference, WorkspaceSettings } from '@/data/workspace'
import { applyTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const FALLBACK_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
]

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; icon: typeof Monitor }> = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

const DEFAULT_SETTINGS: WorkspaceSettings = {
  name: '',
  description: '',
  agentsMd: '',
}

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  theme: 'system',
  timezone: DEFAULT_TIMEZONE,
}

export function SettingsView() {
  const { section } = useParams()
  const { activeWorkspace, updateWorkspace } = useWorkspaces()
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_SETTINGS)
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS)
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false)
  const [globalLoaded, setGlobalLoaded] = useState(false)
  const workspaceSaveTimer = useRef<number | null>(null)
  const globalSaveTimer = useRef<number | null>(null)
  const isGlobalPage = section === 'global'
  const isWorkspacePage = section === 'workspace'

  const timezones = useMemo(() => {
    const values = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : FALLBACK_TIMEZONES
    return values.includes(globalSettings.timezone) ? values : [globalSettings.timezone, ...values]
  }, [globalSettings.timezone])

  const loadSettings = useCallback(async () => {
    if (!activeWorkspace?.path) return
    setWorkspaceLoaded(false)
    const loadedSettings = await electronClient?.readWorkspaceSettings(activeWorkspace.path)
    if (!loadedSettings) return
    setSettings({
      name: loadedSettings.name || activeWorkspace.name,
      description: loadedSettings.description ?? '',
      agentsMd: '',
    })
    setWorkspaceLoaded(true)
  }, [activeWorkspace?.name, activeWorkspace?.path])

  const loadGlobalSettings = useCallback(async () => {
    setGlobalLoaded(false)
    const loadedSettings = await electronClient?.readGlobalSettings()
    if (!loadedSettings) return
    setGlobalSettings({
      theme: loadedSettings.theme ?? 'system',
      timezone: loadedSettings.timezone || DEFAULT_TIMEZONE,
    })
    applyTheme(loadedSettings.theme ?? 'system')
    setGlobalLoaded(true)
  }, [])

  useEffect(() => {
    if (!isWorkspacePage) return
    void loadSettings()
  }, [isWorkspacePage, loadSettings])

  useEffect(() => {
    if (!isGlobalPage) return
    void loadGlobalSettings()
  }, [isGlobalPage, loadGlobalSettings])

  useEffect(() => {
    if (!isWorkspacePage || !activeWorkspace?.path) return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    electronClient?.watchWorkspace(activeWorkspace.path, (data) => {
      if (data.workspacePath !== activeWorkspace.path) return
      void loadSettings()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [activeWorkspace?.path, isWorkspacePage, loadSettings])

  useEffect(() => {
    if (!isWorkspacePage || !workspaceLoaded || !activeWorkspace?.path) return
    if (workspaceSaveTimer.current) window.clearTimeout(workspaceSaveTimer.current)

    workspaceSaveTimer.current = window.setTimeout(() => {
      void electronClient?.writeWorkspaceSettings(activeWorkspace.path, settings).then((saved) => {
        updateWorkspace(activeWorkspace.id, { name: saved.name || activeWorkspace.name })
      })
    }, 500)

    return () => {
      if (workspaceSaveTimer.current) window.clearTimeout(workspaceSaveTimer.current)
    }
  }, [activeWorkspace?.id, activeWorkspace?.name, activeWorkspace?.path, isWorkspacePage, workspaceLoaded, settings, updateWorkspace])

  useEffect(() => {
    if (!isGlobalPage || !globalLoaded) return
    if (globalSaveTimer.current) window.clearTimeout(globalSaveTimer.current)

    applyTheme(globalSettings.theme)
    globalSaveTimer.current = window.setTimeout(() => {
      void electronClient?.writeGlobalSettings(globalSettings)
    }, 500)

    return () => {
      if (globalSaveTimer.current) window.clearTimeout(globalSaveTimer.current)
    }
  }, [globalLoaded, globalSettings, isGlobalPage])

  const patchSettings = (patch: Partial<WorkspaceSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  const patchGlobalSettings = (patch: Partial<GlobalSettings>) => {
    setGlobalSettings((prev) => ({ ...prev, ...patch }))
  }

  if (!isGlobalPage && !isWorkspacePage) return <Navigate to="/settings/global" replace />

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[52px] shrink-0 items-center border-b pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h1 className="text-sm font-semibold">Settings</h1>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 border-r bg-muted/30 p-4 lg:block">
          <nav className="flex flex-col gap-1">
            <SettingsLink to="/settings/global" icon={Monitor} label="Global" active={isGlobalPage} />
            <SettingsLink to="/settings/workspace" icon={Settings} label="Workspace" active={isWorkspacePage} />
          </nav>
        </aside>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-3xl flex-col py-7 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
            {isGlobalPage && (
              <section className="grid gap-5">
                <h2 className="text-sm font-semibold">Global Settings</h2>
                <div className="grid gap-2">
                  <span className="text-sm font-medium">Theme</span>
                  <div className="grid grid-cols-3 gap-2">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => patchGlobalSettings({ theme: option.id })}
                        className={cn(
                          'flex h-10 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
                          globalSettings.theme === option.id ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                        )}
                      >
                        <option.icon className="size-4" />
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="grid gap-2">
                  <span className="text-sm font-medium">Timezone</span>
                  <select
                    value={globalSettings.timezone}
                    onChange={(event) => patchGlobalSettings({ timezone: event.target.value })}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                  </select>
                </label>
              </section>
            )}

            {isWorkspacePage && (
              <section className="grid gap-5">
                <h2 className="text-sm font-semibold">Workspace Settings</h2>
                <label className="grid gap-2">
                  <span className="text-sm font-medium">Name</span>
                  <Input value={settings.name} onChange={(event) => patchSettings({ name: event.target.value })} placeholder="Workspace name" />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium">Description</span>
                  <Textarea
                    value={settings.description}
                    onChange={(event) => patchSettings({ description: event.target.value })}
                    placeholder="What this workspace is for..."
                    className="min-h-[96px] resize-none text-sm leading-6"
                  />
                </label>
              </section>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function SettingsLink({ to, icon: Icon, label, active }: { to: string; icon: typeof Settings; label: string; active?: boolean }) {
  return (
    <NavLink
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-background hover:text-foreground',
        active ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border/70' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-4" />
      <span>{label}</span>
    </NavLink>
  )
}
