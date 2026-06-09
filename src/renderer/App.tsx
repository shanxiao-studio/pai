import { Routes, Route, Navigate } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { OverviewView } from './components/overview/OverviewView'
import { ChatView } from './components/chat/ChatView'
import { IssuesView } from './components/issues/IssuesView'
import { AllIssuesView } from './components/issues/AllIssuesView'
import { SettingsView } from './components/settings/SettingsView'
import { ProjectProvider, useProjects } from './components/project/ProjectProvider'
import { WorkspaceProvider, useWorkspaces } from './components/workspace/WorkspaceProvider'
import { WelcomeScreen } from './components/workspace/WelcomeScreen'
import { applyTheme } from './lib/theme'
import type { ThemePreference } from './data/workspace'
import { useEffect } from 'react'
import { electronClient } from './shared/api/electron-client'

export default function App() {
  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  )
}

function AppContent() {
  const { activeWorkspace } = useWorkspaces()

  useEffect(() => {
    if (!activeWorkspace?.path) return
    let cancelled = false
    electronClient?.readWorkspaceSettings(activeWorkspace.path).then((settings) => {
      if (!cancelled) applyTheme(settings.theme as ThemePreference)
    })
    return () => { cancelled = true }
  }, [activeWorkspace?.path])

  if (!activeWorkspace) {
    return <WelcomeScreen />
  }

  return (
    <ProjectProvider key={activeWorkspace.id} workspaceId={activeWorkspace.id} workspacePath={activeWorkspace.path}>
      <AppRoutes />
    </ProjectProvider>
  )
}

function AppRoutes() {
  const { projects } = useProjects()
  const firstProject = projects[0]

  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route
          index
          element={
            firstProject ? (
              <Navigate to={`/project/${firstProject.slug}/overview`} replace />
            ) : (
              <Navigate to="/project/overview" replace />
            )
          }
        />
        <Route path="issues" element={<AllIssuesView />} />
        <Route path="settings" element={<SettingsView />} />
        <Route path="project/:name/*" element={<ProjectRoutes />} />
      </Route>
    </Routes>
  )
}

function ProjectRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="overview" replace />} />
      <Route path="overview" element={<OverviewView />} />
      <Route path="chat" element={<ChatView />} />
      <Route path="issues" element={<IssuesView />} />
      <Route path="issues/:issueId" element={<IssuesView />} />
    </Routes>
  )
}
