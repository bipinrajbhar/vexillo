import { Outlet } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { authClient } from '@/lib/auth-client'

export function AuthLayout() {
  const { data: session } = authClient.useSession()

  const shellSession = session
    ? {
        user: {
          email: session.user.email,
          role: (session.user as { role?: string | null }).role ?? null,
        },
      }
    : null

  return (
    <AppShell session={shellSession}>
      <Outlet />
    </AppShell>
  )
}
