import { createRootRoute, createRoute, redirect } from '@tanstack/react-router'
import { RootLayout } from './routes/__root'
import { SignInPage } from './routes/sign-in'
import { AuthLayout } from './routes/_auth'
import { HomePage } from './routes/_auth/index'
import { FlagDetailPage } from './routes/_auth/flags.$key'
import { EnvironmentsPage } from './routes/_auth/environments'
import { MembersPage } from './routes/_auth/members'
import { authClient } from '@/lib/auth-client'

// Root route — wraps everything in ThemeProvider / Toaster
const rootRoute = createRootRoute({
  component: RootLayout,
})

// Public: /sign-in
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
})

// Layout-only route (no path segment) — guards all authenticated pages
const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  beforeLoad: async ({ location }) => {
    const { data: session } = await authClient.getSession()
    if (!session) {
      throw redirect({
        to: '/sign-in',
        search: { next: location.href },
      })
    }
  },
  component: AuthLayout,
})

// Protected: /
const indexRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/',
  component: HomePage,
})

// Protected: /flags/:key — flag detail
const flagDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/flags/$key',
  component: FlagDetailPage,
})

// Protected: /environments (placeholder, filled in Phase 7)
const environmentsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/environments',
  component: EnvironmentsPage,
})

// Protected: /members (placeholder, filled in Phase 7)
const membersRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/members',
  component: MembersPage,
})

export const routeTree = rootRoute.addChildren([
  signInRoute,
  authRoute.addChildren([indexRoute, flagDetailRoute, environmentsRoute, membersRoute]),
])
