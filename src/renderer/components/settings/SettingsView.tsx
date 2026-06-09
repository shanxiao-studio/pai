import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, FileText, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useWorkspaces } from '@/components/workspace/WorkspaceProvider'
import type { ThemePreference, WorkspaceSettings } from '@/data/workspace'
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
  theme: 'system',
  timezone: DEFAULT_TIMEZONE,
}

export function SettingsView() {
  const { activeWorkspace, updateWorkspace } = useWorkspaces()
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef<number | null>(null)

  const timezones = useMemo(() => {
    const values = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : FALLBACK_TIMEZONES
    return values.includes(settings.timezone) ? values : [settings.timezone, ...values]
  }, [settings.timezone])

  const loadSettings = useCallback(async () => {
    if (!activeWorkspace?.path) return
    setLoaded(false)
    const loadedSettings = await electronClient?.readWorkspaceSettings(activeWorkspace.path)
    if (!loadedSettings) return
    setSettings({
      name: loadedSettings.name || activeWorkspace.name,
      description: loadedSettings.description ?? '',
      agentsMd: loadedSettings.agentsMd ?? '',
      theme: loadedSettings.theme ?? 'system',
      timezone: loadedSettings.timezone || DEFAULT_TIMEZONE,
    })
    applyTheme(loadedSettings.theme ?? 'system')
    setLoaded(true)
  }, [activeWorkspace?.name, activeWorkspace?.path])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    if (!activeWorkspace?.path) return

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
  }, [activeWorkspace?.path, loadSettings])

  useEffect(() => {
    if (!loaded || !activeWorkspace?.path) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)

    applyTheme(settings.theme)
    saveTimer.current = window.setTimeout(() => {
      void electronClient?.writeWorkspaceSettings(activeWorkspace.path, settings).then((saved) => {
        updateWorkspace(activeWorkspace.id, { name: saved.name || activeWorkspace.name })
      })
    }, 500)

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [activeWorkspace?.id, activeWorkspace?.name, activeWorkspace?.path, loaded, settings, updateWorkspace])

  const patchSettings = (patch: Partial<WorkspaceSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[52px] shrink-0 items-center border-b pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h1 className="text-sm font-semibold">Settings</h1>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 border-r bg-muted/30 p-4 lg:block">
          <nav className="flex flex-col gap-1">
            <SettingsLink icon={Settings} label="Workspace" active />
            <SettingsLink icon={FileText} label="AGENTS.md" />
            <SettingsLink icon={Monitor} label="Appearance" />
            <SettingsLink icon={Clock} label="Time" />
          </nav>
        </aside>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-3xl flex-col py-7 pl-[calc(var(--traffic-light-safe-width,0px)+1.75rem)] pr-7">
            <section className="grid gap-5 border-b pb-8">
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

            <section className="grid gap-5 border-b py-8">
              <Textarea
                value={settings.agentsMd}
                onChange={(event) => patchSettings({ agentsMd: event.target.value })}
                placeholder="Workspace-level agent instructions..."
                className="min-h-[240px] resize-y font-mono text-xs leading-6"
              />
            </section>

            <section className="grid gap-5 border-b py-8">
              <div className="grid grid-cols-3 gap-2">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => patchSettings({ theme: option.id })}
                    className={cn(
                      'flex h-10 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
                      settings.theme === option.id ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <option.icon className="size-4" />
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="grid gap-5 py-8">
              <label className="grid gap-2">
                <span className="text-sm font-medium">Timezone</span>
                <select
                  value={settings.timezone}
                  onChange={(event) => patchSettings({ timezone: event.target.value })}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                </select>
              </label>
            </section>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function SettingsLink({ icon: Icon, label, active }: { icon: typeof Settings; label: string; active?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', active ? 'bg-background font-medium shadow-sm ring-1 ring-border/70' : 'text-muted-foreground')}>
      <Icon className="size-4" />
      <span>{label}</span>
    </div>
  )
}
