import { useState, useEffect, useCallback } from 'react'
import { Shield, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
  if (!res.ok) throw new Error(`Failed to load super admins (${res.status})`)
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
    throw new Error(data.error ?? 'Failed to remove admin')
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
      toast.success(`Admin access removed for ${user.email}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove admin')
    } finally {
      setDemoting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !demoting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove admin access?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <strong>{user.email}</strong> will lose super admin access immediately.
          They can be re-promoted by adding their email to{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">SUPER_ADMIN_EMAILS</code>{' '}
          and signing in again.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={demoting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDemote} disabled={demoting}>
            {demoting ? 'Removing…' : 'Remove admin'}
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
      setError(err instanceof Error ? err.message : 'Failed to load super admins')
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
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <Shield
            className="h-5 w-5 text-muted-foreground mt-0.5"
            strokeWidth={1.75}
          />
          <div>
            <p className="page-eyebrow">Super admin</p>
            <h1 className="page-title">Super Admins</h1>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="surface-card divide-y divide-border">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-7 w-24 rounded-md" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Shield
              className="h-5 w-5 text-muted-foreground"
              strokeWidth={1.5}
            />
          </div>
          <h2 className="text-base font-medium text-foreground mb-1">
            No super admins
          </h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            Add an email to{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">SUPER_ADMIN_EMAILS</code>{' '}
            to grant super admin access on next sign-in.
          </p>
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div className="surface-card divide-y divide-border">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center gap-4 px-5 py-4 sm:px-6"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {user.email}
                  {user.id === currentUserId && (
                    <span className="ml-2 text-xs text-muted-foreground font-normal">(you)</span>
                  )}
                </p>
                {user.name && (
                  <p className="text-[0.75rem] text-muted-foreground mt-0.5 truncate">
                    {user.name}
                  </p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-3">
                <span className="text-[0.75rem] text-muted-foreground hidden sm:inline">
                  {new Date(user.createdAt).toLocaleDateString()}
                </span>
                {user.id !== currentUserId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDemoteTarget(user)}
                    className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/50"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                    Remove admin
                  </Button>
                )}
              </div>
            </div>
          ))}
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
