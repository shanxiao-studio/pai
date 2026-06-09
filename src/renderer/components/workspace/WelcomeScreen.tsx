import { useState } from 'react'
import { Folder, FolderOpen, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaces } from './WorkspaceProvider'
import { basename, cn } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'

export function WelcomeScreen() {
  const { workspaces, setActiveWorkspace, createWorkspaceAt, openWorkspace } = useWorkspaces()
  const [loadingAction, setLoadingAction] = useState<'create' | 'open' | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceLocation, setWorkspaceLocation] = useState('')

  const handleChooseLocation = async () => {
    const folderPath = await electronClient?.openFolder()
    if (!folderPath) return
    setWorkspaceLocation(folderPath)
    if (!workspaceName.trim()) setWorkspaceName(basename(folderPath))
  }

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim() || !workspaceLocation) return
    setLoadingAction('create')
    try {
      await createWorkspaceAt(workspaceName.trim(), workspaceLocation)
    } finally {
      setLoadingAction(null)
    }
  }

  const handleOpenWorkspace = async () => {
    setLoadingAction('open')
    try {
      await openWorkspace()
    } finally {
      setLoadingAction(null)
    }
  }

  return (
    <div className="app-shell flex h-screen w-screen items-center justify-center px-6">
      <div className="content-enter flex w-full max-w-md flex-col gap-6 rounded-xl border bg-[hsl(var(--surface-raised))] p-8 shadow-2xl shadow-black/[0.07]">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary shadow-sm shadow-primary/20">
          <FolderOpen className="size-6 text-primary-foreground" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Pai</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A workspace is a local folder where your projects live.
            Create a new one or open an existing workspace folder.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={() => setCreateOpen(true)} disabled={loadingAction !== null} className="shadow-sm">
            <Plus className="mr-2 size-4" />
            {loadingAction === 'create' ? 'Creating...' : 'Create Workspace'}
          </Button>
          <Button variant="outline" onClick={handleOpenWorkspace} disabled={loadingAction !== null}>
            <FolderOpen className="mr-2 size-4" />
            {loadingAction === 'open' ? 'Opening...' : 'Open Workspace'}
          </Button>
        </div>

        {workspaces.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Recent Workspaces</div>
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => setActiveWorkspace(workspace)}
                  className={cn(
                    'pressable flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/60',
                    loadingAction !== null && 'pointer-events-none opacity-60',
                  )}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{workspace.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{workspace.path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-6 backdrop-blur-sm">
          <div className="modal-enter w-full max-w-md rounded-lg border bg-background p-5 shadow-xl shadow-black/[0.08]">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create Workspace</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="pressable rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Workspace Name</span>
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="My Workspace"
                  autoFocus
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Location</span>
                <div className="flex gap-2">
                  <Input value={workspaceLocation} readOnly placeholder="Choose a folder..." className="min-w-0 flex-1 font-mono text-xs" />
                  <Button type="button" variant="outline" onClick={handleChooseLocation}>
                    Choose
                  </Button>
                </div>
              </label>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={loadingAction !== null}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleCreateWorkspace}
                  disabled={loadingAction !== null || !workspaceName.trim() || !workspaceLocation}
                >
                  {loadingAction === 'create' ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
