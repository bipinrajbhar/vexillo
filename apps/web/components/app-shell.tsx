"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { ModeToggle } from "@/components/mode-toggle"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

function headerTitle(pathname: string): string {
  if (pathname === "/") return "Feature flags"
  if (pathname.startsWith("/environments")) return "Environments"
  if (pathname.startsWith("/members")) return "Members"
  if (pathname.startsWith("/flags/")) {
    const key = pathname.slice("/flags/".length)
    const decoded = key ? decodeURIComponent(key) : ""
    return decoded || "Flag"
  }
  return "Vexillo"
}

export function AppShell({
  session,
  children,
}: {
  session: { user: { email: string; role?: string | null } } | null
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const title = headerTitle(pathname)

  if (pathname === "/sign-in") {
    return <>{children}</>
  }

  return (
    <SidebarProvider>
      <AppSidebar session={session} />
      <SidebarInset className="min-h-dvh min-w-0">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm supports-backdrop-filter:bg-background/80 sm:px-6">
          <SidebarTrigger className="-ms-1" />
          <div
            className="min-w-0 flex-1 truncate font-heading text-[0.9375rem] font-medium tracking-[-0.015em] text-foreground sm:text-base"
            title={pathname.startsWith("/flags/") ? title : undefined}
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
