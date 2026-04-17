import * as React from 'react'
import { useRouterState } from '@tanstack/react-router'

import { AppSidebar } from '@/components/app-sidebar'
import { ModeToggle } from '@/components/mode-toggle'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import type { OrgInfo } from '@/lib/org-context'

function headerTitle(pathname: string): string {
  // /org/:slug/flags/:key → flag key
  const flagDetailMatch = pathname.match(/^\/org\/[^/]+\/flags\/(.+)$/)
  if (flagDetailMatch) {
    const key = decodeURIComponent(flagDetailMatch[1])
    return key || 'Flag'
  }
  if (pathname.match(/^\/org\/[^/]+\/flags$/)) return 'Flags'
  if (pathname.match(/^\/org\/[^/]+\/environments$/)) return 'Environments'
  if (pathname.match(/^\/org\/[^/]+\/members$/)) return 'Members'
  if (pathname.match(/^\/org\/[^/]+\/settings$/)) return 'Settings'
if (pathname.match(/^\/org\/[^/]+\/admin\/orgs\/[^/]+/)) return 'Organization'
  if (pathname.match(/^\/org\/[^/]+\/admin/)) return 'Organizations'
  return 'Vexillo'
}

export function AppShell({
  org,
  role,
  userEmail,
  isSuperAdmin,
  children,
}: {
  org: OrgInfo
  role: string
  userEmail: string
  isSuperAdmin?: boolean
  children: React.ReactNode
}) {
  const { location } = useRouterState()
  const pathname = location.pathname
  const title = headerTitle(pathname)
  const isFlagDetail = !!pathname.match(/^\/org\/[^/]+\/flags\/.+$/)

  return (
    <SidebarProvider>
      <AppSidebar org={org} role={role} userEmail={userEmail} isSuperAdmin={isSuperAdmin} />
      <SidebarInset className="min-h-dvh min-w-0">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm supports-backdrop-filter:bg-background/80 sm:px-6">
          <SidebarTrigger className="-ms-1" />
          <div
            className="min-w-0 flex-1 truncate font-heading text-[0.9375rem] font-medium tracking-[-0.015em] text-foreground sm:text-base"
            title={isFlagDetail ? title : undefined}
          >
            {title}
          </div>
          <div className="flex h-6 w-px shrink-0 bg-border" aria-hidden />
          <div className="flex shrink-0 items-center gap-2">
            <ModeToggle />
          </div>
        </header>
        <main
          id="main-content"
          className="main-canvas relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
