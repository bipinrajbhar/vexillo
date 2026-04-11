import { Flag } from 'lucide-react'
import { ModeToggle } from '@/components/mode-toggle'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { useSearch } from '@tanstack/react-router'

export function SignInPage() {
  const search = useSearch({ strict: false }) as { next?: string }

  async function handleSignIn() {
    const callbackURL = search.next
      ? new URL(search.next, window.location.origin).toString()
      : window.location.origin + '/'
    await authClient.signIn.oauth2({
      providerId: 'okta',
      callbackURL,
    })
  }

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden">
      {/* Subtle dot-grid background */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          backgroundImage:
            'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage:
            'radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 100%)',
          opacity: 0.6,
        }}
      />

      <div className="absolute end-4 top-4 z-10 sm:end-6 sm:top-6">
        <ModeToggle />
      </div>

      {/* Main content — nudged slightly above true center */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-5 pb-24 pt-16 sm:px-8">
        <div className="w-full max-w-sm">
          {/* Logomark */}
          <div className="page-enter mb-8 flex flex-col items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card shadow-surface">
              <Flag className="h-5 w-5 text-foreground" strokeWidth={1.75} />
            </div>

            <header className="text-center">
              <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
                Sign in to Vexillo
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Feature flag management for your team
              </p>
            </header>
          </div>

          <div className="page-enter page-enter-delay-1">
            <Button type="button" className="h-10 w-full" onClick={handleSignIn}>
              Continue with Okta
            </Button>
          </div>

          {/* Footer hint */}
          <p className="page-enter page-enter-delay-2 mt-5 text-center text-xs text-muted-foreground/70">
            By continuing, you agree to your organization&apos;s SSO policy.
          </p>
        </div>
      </div>

      {/* Page footer */}
      <footer className="relative pb-6 text-center">
        <p className="text-[0.6875rem] text-muted-foreground/50">
          &copy; {new Date().getFullYear()} Vexillo
        </p>
      </footer>
    </div>
  )
}
