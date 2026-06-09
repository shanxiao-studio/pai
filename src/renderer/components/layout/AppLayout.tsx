import { Outlet } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from '../sidebar/Sidebar'
import { Breadcrumb } from './Breadcrumb'

const SIDEBAR_COLLAPSED_KEY = 'pai.sidebarCollapsed'
const TRAFFIC_LIGHT_SAFE_WIDTH = 80

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed)

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed))
  }, [sidebarCollapsed])

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden">
      <Sidebar isCollapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebarCollapsed} />
      <main
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/85"
        style={{ '--traffic-light-safe-width': sidebarCollapsed ? `${TRAFFIC_LIGHT_SAFE_WIDTH}px` : '0px' } as CSSProperties}
      >
        <Breadcrumb sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebarCollapsed} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
