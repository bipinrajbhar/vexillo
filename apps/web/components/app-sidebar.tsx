import { Link, useRouterState } from '@tanstack/react-router'
import { Boxes, Building2, Flag, Shield, Users } from 'lucide-react'

import { SignOutButton } from '@/components/sign-out-button'
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
} from '@/components/ui/sidebar'
import type { OrgInfo } from '@/lib/org-context'

export function AppSidebar({
  org,
  role,
  userEmail,
  isSuperAdmin = false,
}: {
  org: OrgInfo
  role: string
  userEmail: string
  isSuperAdmin?: boolean
}) {
  const { location } = useRouterState()
  const pathname = location.pathname
  const slug = org.slug
  const isAdmin = role === 'admin'

  const flagsPath = `/org/${slug}/flags`
  const environmentsPath = `/org/${slug}/environments`
  const membersPath = `/org/${slug}/members`

  return (
    <Sidebar collapsible="offcanvas" className="bg-sidebar">
      <SidebarHeader className="gap-0 border-b border-sidebar-border px-4 py-5">
        <Link
          to="/org/$slug/flags"
          params={{ slug }}
          className="block rounded-sm outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="font-heading text-lg font-medium tracking-[-0.02em] text-sidebar-foreground">
            {org.name}
          </span>
          <span className="mt-0.5 block text-[0.65rem] font-medium text-sidebar-foreground/50">
            {slug}
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-3 pt-4">
        <SidebarGroup className="px-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={
                    pathname === flagsPath ||
                    pathname.startsWith(`/org/${slug}/flags/`)
                  }
                  className="px-3 py-2.5"
                  render={<Link to="/org/$slug/flags" params={{ slug }} />}
                >
                  <Flag className="opacity-80" />
                  <span className="font-medium">Flags</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === environmentsPath}
                  className="px-3 py-2.5"
                  render={<Link to="/org/$slug/environments" params={{ slug }} />}
                >
                  <Boxes className="opacity-80" />
                  <span className="font-medium">Environments</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === membersPath}
                    className="px-3 py-2.5"
                    render={<Link to="/org/$slug/members" params={{ slug }} />}
                  >
                    <Users className="opacity-80" />
                    <span className="font-medium">Members</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {isSuperAdmin && (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={
                        pathname === `/org/${slug}/admin` ||
                        pathname.startsWith(`/org/${slug}/admin/orgs`)
                      }
                      className="px-3 py-2.5"
                      render={<Link to="/org/$slug/admin" params={{ slug }} />}
                    >
                      <Building2 className="opacity-80" />
                      <span className="font-medium">Organizations</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={pathname.startsWith(`/org/${slug}/admin/users`)}
                      className="px-3 py-2.5"
                      render={<Link to="/org/$slug/admin/users" params={{ slug }} />}
                    >
                      <Shield className="opacity-80" />
                      <span className="font-medium">Administrators</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4">
        <p
          className="mb-3 truncate text-xs leading-snug text-sidebar-foreground/80"
          title={userEmail}
        >
          {userEmail}
        </p>
        <SignOutButton
          variant="outline"
          size="sm"
          className="w-full justify-center border-sidebar-border bg-sidebar-accent/35 text-sidebar-foreground shadow-surface-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:bg-sidebar-accent/25"
        />
      </SidebarFooter>
    </Sidebar>
  )
}
