"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Boxes, Flag, Users } from "lucide-react"

import { SignOutButton } from "@/components/sign-out-button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function AppSidebar({
  session,
}: {
  session: { user: { email: string; role?: string | null } } | null
}) {
  const pathname = usePathname()
  const isAdmin = session?.user.role === "admin"

  return (
    <Sidebar
      collapsible="offcanvas"
      className="border-r border-sidebar-border/80 bg-sidebar"
    >
      <SidebarHeader className="gap-0 border-b border-sidebar-border/70 px-4 py-5">
        <Link
          href="/"
          className="block rounded-sm outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="font-heading text-lg font-medium tracking-[-0.02em] text-sidebar-foreground">
            Vexillo
          </span>
          <span className="mt-0.5 block text-[0.65rem] font-medium text-sidebar-foreground/50">
            Feature flags
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-3 pt-4">
        <SidebarGroup className="px-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/" || pathname.startsWith("/flags/")}
                  className="px-3 py-2.5"
                  render={<Link href="/" />}
                >
                  <Flag className="opacity-80" />
                  <span className="font-medium">Flags</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith("/environments")}
                  className="px-3 py-2.5"
                  render={<Link href="/environments" />}
                >
                  <Boxes className="opacity-80" />
                  <span className="font-medium">Environments</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname.startsWith("/members")}
                    className="px-3 py-2.5"
                    render={<Link href="/members" />}
                  >
                    <Users className="opacity-80" />
                    <span className="font-medium">Members</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/70 p-4">
        {session ? (
          <>
            <p
              className="mb-3 truncate text-[0.7rem] leading-snug text-sidebar-foreground/70"
              title={session.user.email}
            >
              {session.user.email}
            </p>
            <SignOutButton variant="outline" size="sm" className="w-full justify-center" />
          </>
        ) : null}
      </SidebarFooter>
    </Sidebar>
  )
}
