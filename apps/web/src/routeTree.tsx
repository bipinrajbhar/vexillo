import { createRootRoute, createRoute, redirect } from '@tanstack/react-router'
import { RootLayout } from './routes/__root'
import { SignInPage } from './routes/sign-in'
import { WorkspacePage } from './routes/index'
import { OrgLayout } from './routes/org.$slug'
import { FlagsPage } from './routes/_auth/index'
import { FlagDetailPage } from './routes/_auth/flags.$key'
import { EnvironmentsPage } from './routes/_auth/environments'
import { MembersPage } from './routes/_auth/members'
import { authClient } from '@/lib/auth-client'
import type { OrgInfo } from '@/lib/org-context'

// Root route — wraps everything in ThemeProvider / Toaster
const rootRoute = createRootRoute({
  component: RootLayout,
})

// Public: /sign-in — platform sign-in for super-admins and legacy redirect
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
})

// Public: / — "find your workspace" slug entry form
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspacePage,
})

// Org layout: /org/$slug — auth guard + org context loader
const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/org/$slug',
  beforeLoad: async ({ params, location }) => {
    const { data: session } = await authClient.getSession()
    if (!session) {
      throw redirect({ to: '/sign-in', search: { next: location.href } })
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

export const routeTree = rootRoute.addChildren([
  signInRoute,
  indexRoute,
  orgRoute.addChildren([flagsRoute, flagDetailRoute, environmentsRoute, membersRoute]),
])
