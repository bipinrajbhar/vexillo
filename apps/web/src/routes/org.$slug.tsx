import { Outlet, useRouteContext } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { OrgCtx } from '@/lib/org-context'
import { authClient } from '@/lib/auth-client'
import type { OrgContextValue } from '@/lib/org-context'

export function OrgLayout() {
  // beforeLoad in routeTree.tsx augments context with { org, role }
  const ctx = useRouteContext({ strict: false }) as OrgContextValue
  const { data: session } = authClient.useSession()
  const userEmail = session?.user?.email ?? ''

  return (
    <OrgCtx.Provider value={ctx}>
      <AppShell org={ctx.org} role={ctx.role} userEmail={userEmail}>
        <Outlet />
      </AppShell>
    </OrgCtx.Provider>
  )
}
