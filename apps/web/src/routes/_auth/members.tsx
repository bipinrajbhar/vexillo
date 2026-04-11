import { useState, useEffect, useCallback } from 'react'
import { Users, Trash2, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'

// ── Types ────────────────────────────────────────────────────────────────────

interface Member {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchMembers(): Promise<Member[]> {
  const res = await fetch('/api/dashboard/members')
  if (!res.ok) throw new Error(`Failed to load members (${res.status})`)
  const data = await res.json()
  return data.members
}

async function patchMemberRole(id: string, role: string): Promise<void> {
  const res = await fetch(`/api/dashboard/members/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to update role')
}

async function deleteMember(id: string): Promise<void> {
  const res = await fetch(`/api/dashboard/members/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to remove member')
  }
}

// ── Remove Confirmation Dialog ────────────────────────────────────────────────

function RemoveMemberDialog({
  member,
  onClose,
  onRemoved,
}: {
  member: Member
  onClose: () => void
  onRemoved: (id: string) => void
}) {
  const [removing, setRemoving] = useState(false)

  async function handleRemove() {
    setRemoving(true)
    try {
      await deleteMember(member.id)
      onRemoved(member.id)
      onClose()
      toast.success(`${member.name} removed`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !removing && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove member?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <strong>{member.name}</strong> ({member.email}) will lose access immediately. They can
          sign in again via Okta to rejoin as a viewer.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={removing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleRemove} disabled={removing}>
            {removing ? 'Removing…' : 'Remove member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Member row ────────────────────────────────────────────────────────────────

function MemberRow({
  member,
  currentUserId,
  isAdmin,
  onRoleChange,
  onRemove,
}: {
  member: Member
  currentUserId: string | undefined
  isAdmin: boolean
  onRoleChange: (id: string, role: string) => void
  onRemove: (member: Member) => void
}) {
  const [changingRole, setChangingRole] = useState(false)
  const isSelf = member.id === currentUserId

  async function handleRoleChange(newRole: string) {
    if (newRole === member.role) return
    setChangingRole(true)
    try {
      await patchMemberRole(member.id, newRole)
      onRoleChange(member.id, newRole)
      toast.success(`${member.name} is now a${newRole === 'admin' ? 'n' : ''} ${newRole}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    } finally {
      setChangingRole(false)
    }
  }

  return (
    <div className="flex items-center gap-4 px-5 py-4 sm:px-6">
      {/* Avatar placeholder */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[0.75rem] font-medium text-muted-foreground uppercase select-none">
        {member.name.charAt(0)}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground truncate">{member.name}</p>
          {isSelf && (
            <Badge variant="secondary" className="text-[0.65rem] px-1.5">
              you
            </Badge>
          )}
        </div>
        <p className="text-[0.75rem] text-muted-foreground truncate">{member.email}</p>
      </div>

      {/* Role + actions */}
      <div className="flex items-center gap-2 shrink-0">
        {isAdmin && !isSelf ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium capitalize shadow-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={changingRole}
            >
              {member.role}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleRoleChange('admin')}>
                Admin
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleRoleChange('viewer')}>
                Viewer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Badge variant="secondary" className="capitalize text-xs">
            {member.role}
          </Badge>
        )}

        {isAdmin && !isSelf && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRemove(member)}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:border-destructive/50"
            aria-label={`Remove ${member.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function MembersPage() {
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const isAdmin = (session?.user as { role?: string | null } | undefined)?.role === 'admin'
  const currentUserId = session?.user?.id

  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)

  const load = useCallback(async () => {
    if (sessionPending) return
    if (!isAdmin) {
      setLoading(false)
      return
    }
    try {
      setError(null)
      const result = await fetchMembers()
      setMembers(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, sessionPending])

  useEffect(() => {
    load()
  }, [load])

  function handleRoleChange(id: string, role: string) {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role } : m)))
  }

  function handleRemoved(id: string) {
    setMembers((prev) => prev.filter((m) => m.id !== id))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Users className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
        <div>
          <p className="page-eyebrow">Settings</p>
          <h1 className="page-title">Members</h1>
        </div>
      </div>

      {/* Viewer notice */}
      {!isAdmin && !loading && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground mb-6">
          Only admins can manage members.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="surface-card divide-y divide-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {/* Members list */}
      {!loading && !error && members.length > 0 && (
        <div className="surface-card divide-y divide-border">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              onRoleChange={handleRoleChange}
              onRemove={setRemoveTarget}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && members.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Users className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h2 className="text-base font-medium text-foreground mb-1">No members yet</h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            Members join automatically when they sign in with Okta for the first time.
          </p>
        </div>
      )}

      {/* Hint about joining */}
      {!loading && !error && members.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          New members join automatically when they sign in with Okta. They start as viewers.
        </p>
      )}

      {removeTarget && (
        <RemoveMemberDialog
          member={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={handleRemoved}
        />
      )}
    </div>
  )
}
