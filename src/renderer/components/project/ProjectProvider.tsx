import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectConfig } from '@/data/project'
import { electronClient } from '@/shared/api/electron-client'

interface ProjectContextValue {
  projects: ProjectConfig[]
  getProject: (slug?: string) => ProjectConfig | undefined
  importExistingProject: () => Promise<ProjectConfig | null>
  removeProject: (project: ProjectConfig) => Promise<ProjectConfig[]>
  updateProject: (project: ProjectConfig, patch: Partial<ProjectConfig>) => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({
  children,
  workspaceId,
  workspacePath,
}: {
  children: ReactNode
  workspaceId: string
  workspacePath: string
}) {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const loadedRef = useRef(false)

  const loadProjects = useCallback(async () => {
    const configProjects = await electronClient?.readConfig(workspacePath)
    setProjects(normalizeProjects(configProjects ?? []))
    loadedRef.current = true
  }, [workspacePath])

  // Load projects from .pai/pai.toml on mount / workspace change
  useEffect(() => {
    let cancelled = false
    loadedRef.current = false

    async function load() {
      const configProjects = await electronClient?.readConfig(workspacePath)
      if (cancelled) return
      setProjects(normalizeProjects(configProjects ?? []))
      loadedRef.current = true
    }

    load()

    return () => {
      cancelled = true
    }
  }, [workspacePath])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    electronClient?.watchWorkspace(workspacePath, (data) => {
      if (data.workspacePath !== workspacePath) return
      void loadProjects()
    }).then((cleanup) => {
      if (cancelled) cleanup()
      else unsubscribe = cleanup
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [loadProjects, workspacePath])

  useEffect(() => {
    const projectPaths = projects.map((project) => project.path).filter((path): path is string => Boolean(path))
    if (projectPaths.length === 0) return

    let cancelled = false
    const unsubscribers: Array<() => void> = []

    for (const projectPath of projectPaths) {
      void electronClient?.watchProject(projectPath, (data) => {
        if (!projectPaths.includes(data.projectPath)) return
        void loadProjects()
      }).then((cleanup) => {
        if (cancelled) cleanup()
        else unsubscribers.push(cleanup)
      })
    }

    return () => {
      cancelled = true
      unsubscribers.forEach((cleanup) => cleanup())
    }
  }, [loadProjects, projects])

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      getProject: (slug) => slug ? projects.find((p) => p.slug === slug) : projects[0],
      importExistingProject: async () => {
        const imported = await electronClient?.importProject()
        if (!imported) return null

        // Persist to .pai/pai.toml
        if (imported.path) {
          const saved = await electronClient?.addProjectToConfig(workspacePath, imported.path)
          if (saved) {
            setProjects((prev) => {
              const exists = prev.some((p) => p.path === saved.path)
              if (exists) {
                return prev.map((p) => (p.path === saved.path ? { ...p, ...saved } : p))
              }
              return [...prev, { ...saved, slug: uniqueSlug(saved.slug, prev) }]
            })
            return saved
          }
        }

        // Fallback: add without config persistence
        setProjects((prev) => {
          const exists = prev.some((p) => p.path === imported.path)
          if (exists) return prev
          return [...prev, { ...imported, slug: uniqueSlug(imported.slug, prev) }]
        })
        return imported
      },
      removeProject: async (project) => {
        if (project.path) {
          await electronClient?.removeProjectFromConfig(workspacePath, project.path)
        }

        const updated = projects.filter((item) => !isSameProject(item, project))
        setProjects(updated)
        return updated
      },
      updateProject: (project, patch) => {
        setProjects((prev) => prev.map((item) => (
          isSameProject(item, project)
            ? { ...item, ...patch, slug: item.slug }
            : item
        )))
      },
    }),
    [projects, workspacePath],
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProjects() {
  const value = useContext(ProjectContext)
  if (!value) {
    throw new Error('useProjects must be used inside ProjectProvider')
  }
  return value
}

function uniqueSlug(slug: string, projects: ProjectConfig[]) {
  if (!projects.some((p) => p.slug === slug)) return slug

  let index = 2
  while (projects.some((p) => p.slug === `${slug}-${index}`)) {
    index += 1
  }
  return `${slug}-${index}`
}

function normalizeProjects(projects: ProjectConfig[]) {
  const normalized: ProjectConfig[] = []
  const seenPaths = new Set<string>()

  for (const project of projects) {
    const key = project.path ?? project.slug
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    normalized.push({
      ...project,
      status: normalizeProjectStatus(project.status),
      slug: uniqueSlug(project.slug, normalized),
    })
  }

  return normalized
}

function isSameProject(a: ProjectConfig, b: ProjectConfig) {
  if (a.path || b.path) return Boolean(a.path && b.path && a.path === b.path)
  return a.slug === b.slug
}

function normalizeProjectStatus(status: ProjectConfig['status'] | undefined) {
  return status === 'todo' || status === 'in_progress' || status === 'done' ? status : 'backlog'
}
