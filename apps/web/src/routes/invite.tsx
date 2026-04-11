import { useState, useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'

type State =
  | { phase: 'loading' }
  | { phase: 'needs-auth' }
  | { phase: 'accepting' }
  | { phase: 'success'; orgId: string }
  | { phase: 'error'; message: string }

export function InviteAcceptPage() {
  const search = useSearch({ strict: false }) as { token?: string }
  const navigate = useNavigate()
  const token = search.token ?? ''

  const [state, setState] = useState<State>({ phase: 'loading' })
  const { data: session } = authClient.useSession()

  useEffect(() => {
    if (!token) {
      setState({ phase: 'error', message: 'Invalid invite link — no token provided.' })
      return
    }

    // Wait for session to resolve (session === undefined while loading)
    if (session === undefined) return

    if (!session) {
      setState({ phase: 'needs-auth' })
      return
    }

    // User is signed in — accept the invite
    setState({ phase: 'accepting' })
    fetch('/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
        return data as { orgId: string; role: string }
      })
      .then((data) => {
        setState({ phase: 'success', orgId: data.orgId })
      })
      .catch((err: unknown) => {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Failed to accept invite.',
        })
      })
  }, [token, session])

  // After success, auto-redirect to workspace finder (user can then enter their org slug)
  useEffect(() => {
    if (state.phase === 'success') {
      const t = setTimeout(() => navigate({ to: '/' }), 2000)
      return () => clearTimeout(t)
    }
  }, [state, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm text-center space-y-4">
        {state.phase === 'loading' && (
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
        )}

        {state.phase === 'needs-auth' && (
          <>
            <h1 className="text-lg font-semibold">Sign in to accept your invite</h1>
            <p className="text-sm text-muted-foreground">
              You need to be signed in before accepting this invitation.
            </p>
            <Button
              onClick={() =>
                navigate({
                  to: '/sign-in',
                  search: { next: `/invite?token=${token}` },
                })
              }
            >
              Sign in
            </Button>
          </>
        )}

        {state.phase === 'accepting' && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Accepting invite…</p>
          </>
        )}

        {state.phase === 'success' && (
          <>
            <CheckCircle className="mx-auto h-10 w-10 text-green-500" />
            <h1 className="text-lg font-semibold">You're in!</h1>
            <p className="text-sm text-muted-foreground">
              Redirecting you to your workspace…
            </p>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <XCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="text-lg font-semibold">Invite invalid</h1>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <Button variant="outline" onClick={() => navigate({ to: '/' })}>
              Go to workspace finder
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
