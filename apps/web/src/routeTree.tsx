import { createRootRoute, createRoute, redirect } from '@tanstack/react-router'
import { RootLayout } from './routes/__root'
import { SignInPage } from './routes/sign-in'
import { WorkspacePage } from './routes/index'
import { OrgLayout } from './routes/org.$slug'
import { FlagsPage } from './routes/_auth/index'
import { FlagDetailPage } from './routes/_auth/flags.$key'
import { EnvironmentsPage } from './routes/_auth/environments'
import { MembersPage } from './routes/_auth/members'
import { AdminLayout } from './routes/admin'
import { AdminOrgsPage } from './routes/admin/index'
import { AdminOrgsNewPage } from './routes/admin/orgs.new'
import { AdminOrgDetailPage } from './routes/admin/orgs.$slug'
import { InviteAcceptPage } from './routes/invite'
import { OrgSignInPage } from './routes/org-sign-in'
import { authClient } from '@/lib/auth-client'
import type { OrgInfo } from '@/lib/org-context'

// Root route — wraps everything in ThemeProvider / Toaster
const rootRoute = createRootRoute({
  component: RootLayout,
})

// Public: /sign-in — platform sign-in for super-admins and org members
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
})

// Public: /invite — accept an org invite via token
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  component: InviteAcceptPage,
})

// Public: / — "find your workspace" slug entry form
// Redirects super-admins straight to /admin, org members to their org
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const { data: session } = await authClient.getSession()
    if (!session) return
    if ((session?.user as Record<string, unknown>)?.isSuperAdmin === true) {
      throw redirect({ to: '/admin' })
    }
    const res = await fetch('/api/dashboard/me/orgs')
    if (res.ok) {
      const { orgs } = await res.json() as { orgs: { slug: string }[] }
      if (orgs.length === 1) {
        throw redirect({ to: `/org/${orgs[0].slug}/flags` })
      }
    }
  },
  component: WorkspacePage,
})

// Public: /org/$slug/sign-in — org-specific Okta sign-in (must be above orgRoute)
const orgSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/org/$slug/sign-in',
  beforeLoad: async ({ params, search }) => {
    const { data: session } = await authClient.getSession()
    if (session) {
      const res = await fetch(`/api/dashboard/${params.slug}/context`)
      if (res.ok) {
        const next = (search as { next?: string }).next
        throw redirect({ to: next ?? `/org/${params.slug}/flags` })
      }
    }
  },
  component: OrgSignInPage,
})

// Org layout: /org/$slug — auth guard + org context loader
const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/org/$slug',
  beforeLoad: async ({ params, location }) => {
    const { data: session } = await authClient.getSession()
    if (!session) {
      throw redirect({ to: '/org/$slug/sign-in', params: { slug: params.slug }, search: { next: location.href } })
    }

    const res = await fetch(`/api/dashboard/${params.slug}/context`)
    if (res.status === 403 || res.status === 404) {
      throw redirect({ to: '/' })
    }
    if (!res.ok) throw new Error(`Failed to load org context (${res.status})`)

    const data = await res.json() as { org: OrgInfo; role: string }
    return data  // augments route context with { org, role }
  },
  component: OrgLayout,
})

// Protected: /org/$slug/flags — flags list
const flagsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/flags',
  component: FlagsPage,
})

// Protected: /org/$slug/flags/$key — flag detail
const flagDetailRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/flags/$key',
  component: FlagDetailPage,
})

// Protected: /org/$slug/environments
const environmentsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/environments',
  component: EnvironmentsPage,
})

// Protected: /org/$slug/members
const membersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/members',
  component: MembersPage,
})

// Admin layout: /admin — super-admin guard
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: async ({ location }) => {
    const { data: session } = await authClient.getSession()
    if (!session) {
      throw redirect({ to: '/sign-in', search: { next: location.href } })
    }
    if ((session?.user as Record<string, unknown>)?.isSuperAdmin !== true) {
      throw redirect({ to: '/' })
    }
  },
  component: AdminLayout,
})

// /admin (index) — org list
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: AdminOrgsPage,
})

// /admin/orgs/new — create org
const adminOrgsNewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/orgs/new',
  component: AdminOrgsNewPage,
})

// /admin/orgs/$slug — org detail
const adminOrgDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/orgs/$slug',
  component: AdminOrgDetailPage,
})

export const routeTree = rootRoute.addChildren([
  signInRoute,
  inviteRoute,
  indexRoute,
  orgSignInRoute,
  orgRoute.addChildren([flagsRoute, flagDetailRoute, environmentsRoute, membersRoute]),
  adminRoute.addChildren([adminIndexRoute, adminOrgsNewRoute, adminOrgDetailRoute]),
])
