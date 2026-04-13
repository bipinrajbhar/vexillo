import { useState, useEffect, useCallback } from 'react'
import { UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { authClient } from '@/lib/auth-client'

// ── Types ────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  name: string
  email: string
  createdAt: string
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await fetch('/api/superadmin/users')
  if (!res.ok) throw new Error(`Failed to load administrators (${res.status})`)
  const data = await res.json()
  return data.users
}

async function demoteUser(userId: string): Promise<void> {
  const res = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isSuperAdmin: false }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to revoke access')
  }
}

// ── Demote confirmation dialog ───────────────────────────────────────────────

function DemoteDialog({
  user,
  onClose,
  onDemoted,
}: {
  user: AdminUser
  onClose: () => void
  onDemoted: (userId: string) => void
}) {
  const [demoting, setDemoting] = useState(false)

  async function handleDemote() {
    setDemoting(true)
    try {
      await demoteUser(user.id)
      onDemoted(user.id)
      onClose()
      toast.success(`Removed ${user.email} from administrators`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke access')
    } finally {
      setDemoting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !demoting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke access?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <strong>{user.email}</strong> will lose this access immediately. They can be
          added again via{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">SUPER_ADMIN_EMAILS</code>{' '}
          before their next sign-in.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={demoting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDemote} disabled={demoting}>
            {demoting ? 'Revoking…' : 'Revoke access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [demoteTarget, setDemoteTarget] = useState<AdminUser | null>(null)

  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await fetchAdminUsers()
      setUsers(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load administrators')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleDemoted(userId: string) {
    setUsers((prev) => prev.filter((u) => u.id !== userId))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-eyebrow mb-1.5">Access</p>
          <h1 className="page-title">Administrators</h1>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Create organizations, manage any tenant, and edit org-wide settings. Remove
            someone below, or list an email in{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SUPER_ADMIN_EMAILS</code>{' '}
            so their next sign-in picks it up.
          </p>
        </div>
      </div>

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">
            No administrators yet
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add an email to{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SUPER_ADMIN_EMAILS</code>{' '}
            so the next sign-in from that address grants access.
          </p>
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div className="table-shell overflow-hidden">
          <div className="hidden grid-cols-[1fr_6.5rem_7.5rem_2.5rem] gap-4 border-b border-border bg-muted/45 px-5 py-3 sm:grid dark:bg-muted/15">
            <span className="data-table-th">Account</span>
            <span className="data-table-th">Role</span>
            <span className="data-table-th">Created</span>
            <span className="sr-only">Actions</span>
          </div>

          {users.map((user) => {
            const isSelf = user.id === currentUserId
            return (
              <div
                key={user.id}
                className="data-table-body-row grid grid-cols-[1fr_auto] gap-4 border-b border-border px-5 py-4 last:border-0 sm:grid-cols-[1fr_6.5rem_7.5rem_2.5rem] sm:items-center sm:px-6"
              >
                <div className="min-w-0">
                  <p className="data-table-primary-label text-[0.9375rem]">{user.email}</p>
                  <p className="mt-0.5 truncate text-[0.8125rem] text-muted-foreground">
                    {user.name || '—'}
                  </p>
                </div>

                <div className="hidden sm:flex sm:items-center">
                  {isSelf ? (
                    <Badge
                      variant="secondary"
                      className="h-6 px-2 text-[0.6875rem] font-medium"
                    >
                      You
                    </Badge>
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">—</span>
                  )}
                </div>

                <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">
                  {new Date(user.createdAt).toLocaleDateString()}
                </span>

                <div className="flex justify-end sm:justify-start">
                  {user.id !== currentUserId ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setDemoteTarget(user)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke administrator access for ${user.email}`}
                    >
                      <UserMinus className="h-4 w-4" />
                    </Button>
                  ) : (
                    <span className="inline-flex h-8 w-8 items-center justify-center text-xs text-muted-foreground">
                      —
                    </span>
                  )}
                </div>

                <div className="col-span-2 flex flex-wrap items-center gap-2 sm:hidden">
                  {isSelf && (
                    <Badge
                      variant="secondary"
                      className="h-6 px-2 text-[0.6875rem] font-medium"
                    >
                      You
                    </Badge>
                  )}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {demoteTarget && (
        <DemoteDialog
          user={demoteTarget}
          onClose={() => setDemoteTarget(null)}
          onDemoted={handleDemoted}
        />
      )}
    </div>
  )
}
