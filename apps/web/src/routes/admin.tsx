import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Flag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ModeToggle } from '@/components/mode-toggle'
import { SignOutButton } from '@/components/sign-out-button'

const NAV_TABS = [
  { label: 'Organizations', to: '/admin' as const, matchPrefix: '/admin/orgs' },
  { label: 'Super Admins', to: '/admin/users' as const, matchPrefix: '/admin/users' },
]

export function AdminLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  function isActive(to: string, matchPrefix: string) {
    if (to === '/admin') {
      return pathname === '/admin' || pathname.startsWith(matchPrefix)
    }
    return pathname === to || pathname.startsWith(matchPrefix)
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/80">
        <div className="flex h-14 items-center gap-3 px-5 sm:px-8">
          <Link
            to="/admin"
            className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity focus-visible:opacity-80 outline-none"
          >
            <Flag className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="font-heading text-[0.9375rem] font-medium tracking-[-0.015em]">
              Vexillo
            </span>
          </Link>
          <div className="flex-1" />
          <Badge
            variant="outline"
            className="hidden text-[0.65rem] font-medium sm:inline-flex"
          >
            super admin
          </Badge>
          <ModeToggle />
          <SignOutButton className="text-muted-foreground text-sm" />
        </div>
        <nav className="flex gap-1 px-5 sm:px-8 -mb-px">
          {NAV_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={[
                'px-1 py-2.5 text-sm border-b-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
                isActive(tab.to, tab.matchPrefix)
                  ? 'border-foreground text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="main-canvas flex-1">
        <Outlet />
      </main>
    </div>
  )
}
