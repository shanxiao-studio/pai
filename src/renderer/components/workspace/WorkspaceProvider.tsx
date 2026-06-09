import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  createWorkspace,
  loadActiveWorkspaceId,
  loadWorkspaces,
  saveActiveWorkspaceId,
  saveWorkspaces,
  Workspace,
} from '@/data/workspace'
import { basename } from '@/lib/utils'
import { electronClient } from '@/shared/api/electron-client'

interface WorkspaceContextValue {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  setActiveWorkspace: (workspace: Workspace) => void
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name'>>) => void
  addWorkspace: () => Promise<Workspace | null>
  createWorkspaceAt: (name: string, parentPath: string) => Promise<Workspace | null>
  openWorkspace: () => Promise<Workspace | null>
  removeWorkspace: (id: string) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces)
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = loadActiveWorkspaceId()
    if (saved && workspaces.some((w) => w.id === saved)) return saved
    return null
  })

  useEffect(() => {
    saveWorkspaces(workspaces)
  }, [workspaces])

  useEffect(() => {
    saveActiveWorkspaceId(activeId)
  }, [activeId])

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  )

  const setActiveWorkspace = useCallback((workspace: Workspace) => {
    setActiveId(workspace.id)
  }, [])

  const updateWorkspace = useCallback((id: string, patch: Partial<Pick<Workspace, 'name'>>) => {
    setWorkspaces((prev) => prev.map((workspace) => (
      workspace.id === id ? { ...workspace, ...patch } : workspace
    )))
  }, [])

  useEffect(() => {
    if (!activeWorkspace?.path) return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    electronClient?.watchWorkspace(activeWorkspace.path, (data) => {
      if (data.workspacePath !== activeWorkspace.path) return
      void electronClient?.readWorkspaceSettings(activeWorkspace.path).then((settings) => {
        if (cancelled || !settings?.name) return
        updateWorkspace(activeWorkspace.id, { name: settings.name })
      })
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [activeWorkspace?.id, activeWorkspace?.path, updateWorkspace])

  const chooseWorkspaceFolder = useCallback(async () => {
    const folderPath = await electronClient?.openFolder()
    if (!folderPath) return null

    const existingWorkspace = workspaces.find((w) => w.path === folderPath)
    if (existingWorkspace) {
      setActiveId(existingWorkspace.id)
      return existingWorkspace
    }

    const name = basename(folderPath)
    const workspace = createWorkspace(name, folderPath)
    setWorkspaces((prev) => [...prev, workspace])
    setActiveId(workspace.id)
    return workspace
  }, [workspaces])

  const addWorkspace = useCallback(async () => chooseWorkspaceFolder(), [chooseWorkspaceFolder])
  const openWorkspace = useCallback(async () => chooseWorkspaceFolder(), [chooseWorkspaceFolder])

  const createWorkspaceAt = useCallback(async (name: string, parentPath: string) => {
    const created = await electronClient?.createWorkspace(name, parentPath)
    if (!created) return null

    const existingWorkspace = workspaces.find((w) => w.path === created.path)
    if (existingWorkspace) {
      setActiveId(existingWorkspace.id)
      return existingWorkspace
    }

    const workspace = createWorkspace(created.name, created.path)
    setWorkspaces((prev) => [...prev, workspace])
    setActiveId(workspace.id)
    return workspace
  }, [workspaces])

  const removeWorkspace = useCallback(
    (id: string) => {
      setWorkspaces((prev) => prev.filter((w) => w.id !== id))
      if (activeId === id) {
        const remaining = workspaces.filter((w) => w.id !== id)
        setActiveId(remaining[0]?.id ?? null)
      }
    },
    [workspaces, activeId],
  )

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaces, activeWorkspace, setActiveWorkspace, updateWorkspace, addWorkspace, createWorkspaceAt, openWorkspace, removeWorkspace }),
    [workspaces, activeWorkspace, setActiveWorkspace, updateWorkspace, addWorkspace, createWorkspaceAt, openWorkspace, removeWorkspace],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaces() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspaces must be used inside WorkspaceProvider')
  return value
}
