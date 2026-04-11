import { useEffect, useState } from 'react'
import { useParams, useSearch } from '@tanstack/react-router'
import { Flag, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModeToggle } from '@/components/mode-toggle'

type OrgMeta = { name: string; slug: string; status: string }
type State =
  | { phase: 'loading' }
  | { phase: 'ready'; org: OrgMeta }
  | { phase: 'not-found' }
  | { phase: 'suspended' }

export function OrgSignInPage() {
  const { slug } = useParams({ strict: false }) as { slug: string }
  const search = useSearch({ strict: false }) as { next?: string }
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    if (!slug) {
      setState({ phase: 'not-found' })
      return
    }
    fetch(`/api/auth/org-oauth/${encodeURIComponent(slug)}/meta`)
      .then(async (res) => {
        if (res.status === 404) { setState({ phase: 'not-found' }); return }
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { org: OrgMeta }
        if (data.org.status === 'suspended') { setState({ phase: 'suspended' }); return }
        setState({ phase: 'ready', org: data.org })
      })
      .catch(() => setState({ phase: 'not-found' }))
  }, [slug])

  function handleSignIn() {
    const next = search.next ?? `/org/${slug}/flags`
    const authorizeUrl =
      `/api/auth/org-oauth/${encodeURIComponent(slug)}/authorize` +
      `?next=${encodeURIComponent(next)}`
    window.location.href = authorizeUrl
  }

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden">
      {/* Dot-grid background */}
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

      <div className="relative flex flex-1 flex-col items-center justify-center px-5 pb-24 pt-16 sm:px-8">
        <div className="w-full max-w-sm">
          {/* Logomark */}
          <div className="page-enter mb-8 flex flex-col items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card shadow-surface">
              <Flag className="h-5 w-5 text-foreground" strokeWidth={1.75} />
            </div>

            {state.phase === 'loading' && (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading workspace…</p>
              </div>
            )}

            {state.phase === 'not-found' && (
              <header className="text-center">
                <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
                  Workspace not found
                </h1>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  No workspace exists for <span className="font-mono">{slug}</span>.
                </p>
              </header>
            )}

            {state.phase === 'suspended' && (
              <header className="text-center">
                <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
                  Workspace suspended
                </h1>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  This workspace is currently suspended. Contact your administrator.
                </p>
              </header>
            )}

            {state.phase === 'ready' && (
              <header className="text-center">
                <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
                  Sign in to {state.org.name}
                </h1>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Use your organisation's Okta account to continue.
                </p>
              </header>
            )}
          </div>

          {state.phase === 'ready' && (
            <div className="page-enter page-enter-delay-1">
              <Button type="button" className="h-10 w-full" onClick={handleSignIn}>
                Continue with Okta
              </Button>
            </div>
          )}

          {(state.phase === 'not-found' || state.phase === 'suspended') && (
            <div className="page-enter page-enter-delay-1 text-center">
              <a href="/" className="text-sm text-muted-foreground underline underline-offset-2">
                Find a different workspace
              </a>
            </div>
          )}

          <p className="page-enter page-enter-delay-2 mt-5 text-center text-xs text-muted-foreground/70">
            By continuing, you agree to your organisation's SSO policy.
          </p>
        </div>
      </div>

      <footer className="relative pb-6 text-center">
        <p className="text-[0.6875rem] text-muted-foreground/50">
          &copy; {new Date().getFullYear()} Vexillo
        </p>
      </footer>
    </div>
  )
}
