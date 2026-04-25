import { useEffect, useState } from 'react'
import { useParams, useSearch } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModeToggle } from '@/components/mode-toggle'
import { VexilloMark } from '@/icons/vexillo'

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
    <div className="relative flex min-h-dvh flex-col bg-background">
      <div className="absolute end-4 top-4 z-10 sm:end-6 sm:top-6">
        <ModeToggle />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-5 py-16 sm:px-8">
        {state.phase === 'loading' ? (
          <div className="page-enter flex flex-col items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading workspace…</p>
          </div>
        ) : (
          <div className="page-enter flex w-full max-w-[420px] flex-col items-center">
            {/* Logo — above card */}
            <div className="mb-5 overflow-hidden" style={{ width: 40, height: 40 }}>
              <VexilloMark
                className="text-foreground"
                style={{ width: 64, height: 64, marginLeft: -10, marginTop: -5 }}
              />
            </div>

            {/* Heading — above card */}
            <h1 className="page-enter-delay-1 mb-6 font-heading text-2xl font-semibold tracking-[-0.02em] text-foreground">
              {state.phase === 'ready' && `Sign in to ${state.org.name}`}
              {state.phase === 'not-found' && 'Workspace not found'}
              {state.phase === 'suspended' && 'Workspace suspended'}
            </h1>

            <div className="page-enter-delay-2 w-full">
              {state.phase === 'ready' && (
                <>
                  <Button type="button" className="h-10 w-full" onClick={handleSignIn}>
                    Continue with Okta
                  </Button>
                  <p className="mt-5 text-center text-xs text-muted-foreground/50">
                    By continuing, you agree to your organisation's SSO policy.
                  </p>
                </>
              )}

              {state.phase === 'not-found' && (
                <>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    No workspace exists for <span className="font-mono">{slug}</span>.
                    Check the URL or contact your administrator.
                  </p>
                  <a
                    href="/"
                    className="mt-5 block text-center text-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    Find a different workspace
                  </a>
                </>
              )}

              {state.phase === 'suspended' && (
                <>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    This workspace is currently suspended. Contact your administrator to restore access.
                  </p>
                  <a
                    href="/"
                    className="mt-5 block text-center text-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    Find a different workspace
                  </a>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <footer className="pb-6 text-center">
        <p className="text-[0.6875rem] text-muted-foreground/40">
          &copy; {new Date().getFullYear()} Vexillo
        </p>
      </footer>
    </div>
  )
}
