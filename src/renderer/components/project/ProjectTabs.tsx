import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toggleMaximize } from '@/lib/window'

export function ProjectTabs() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const activeTab = location.pathname.includes('/chat')
    ? 'chat'
    : location.pathname.includes('/issues')
      ? 'issues'
      : 'overview'

  return (
    <div
      className="flex h-[52px] shrink-0 items-center border-b bg-background/80 pr-8 backdrop-blur lg:pr-10"
      style={{ WebkitAppRegion: 'drag', paddingLeft: 'calc(var(--traffic-light-safe-width, 0px) + 2rem)' } as CSSProperties}
      onDoubleClick={toggleMaximize}
    >
      <Tabs
        className="no-drag"
        value={activeTab}
        onValueChange={(value) => navigate(`/project/${name}/${value}`)}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <TabsList className="grid h-8 grid-cols-3 rounded-md border bg-muted/45 p-0.5 shadow-inner shadow-black/[0.03]">
          <TabsTrigger value="overview" className="h-7 w-20 px-0 text-xs data-[state=active]:shadow-sm">
            Overview
          </TabsTrigger>
          <TabsTrigger value="chat" className="h-7 w-20 px-0 text-xs data-[state=active]:shadow-sm">
            Chat
          </TabsTrigger>
          <TabsTrigger value="issues" className="h-7 w-20 px-0 text-xs data-[state=active]:shadow-sm">
            Issues
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}
