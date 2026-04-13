import { useState, useEffect, useCallback } from 'react'
import { Trash2, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
import { useOrg } from '@/lib/org-context'
import { api, type MemberRow as Member } from '@/lib/api-client'

// ── Remove Confirmation Dialog ────────────────────────────────────────────────

function RemoveMemberDialog({
  orgSlug,
  member,
  onClose,
  onRemoved,
}: {
  orgSlug: string
  member: Member
  onClose: () => void
  onRemoved: (id: string) => void
}) {
  const [removing, setRemoving] = useState(false)

  async function handleRemove() {
    setRemoving(true)
    try {
      await api.members.delete(orgSlug, member.id)
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
          <strong>{member.name}</strong> ({member.email}) will lose access immediately.
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
  orgSlug,
  member,
  currentUserId,
  isAdmin,
  onRoleChange,
  onRemove,
}: {
  orgSlug: string
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
      await api.members.patch(orgSlug, member.id, newRole)
      onRoleChange(member.id, newRole)
      toast.success(`${member.name} is now a${newRole === 'admin' ? 'n' : ''} ${newRole}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    } finally {
      setChangingRole(false)
    }
  }

  const rolePicker = isAdmin && !isSelf && (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={changingRole}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'w-full justify-between gap-1.5 capitalize shadow-surface-xs sm:w-auto',
        )}
      >
        {member.role}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
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
  )

  const roleReadOnly = (!isAdmin || isSelf) && (
    <Badge
      variant="secondary"
      className="h-6 w-full justify-center px-2 text-[0.6875rem] font-medium capitalize sm:w-auto"
    >
      {member.role}
    </Badge>
  )

  return (
    <div className="data-table-body-row grid grid-cols-1 gap-3 border-b border-border px-5 py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_2.5rem] sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[0.75rem] font-medium text-muted-foreground uppercase select-none">
          {member.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="data-table-primary-label text-[0.9375rem]">{member.name}</p>
            {isSelf && (
              <Badge
                variant="secondary"
                className="h-6 px-2 text-[0.6875rem] font-medium"
              >
                You
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-[0.8125rem] text-muted-foreground">
            {member.email}
          </p>
        </div>
      </div>

      <div className="min-w-0 sm:flex sm:items-center">
        {rolePicker}
        {roleReadOnly}
      </div>

      <span className="text-sm tabular-nums text-muted-foreground">
        {new Date(member.createdAt).toLocaleDateString()}
      </span>

      <div className="flex justify-start sm:justify-end">
        {isAdmin && !isSelf ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onRemove(member)}
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${member.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : (
          <span className="inline-flex h-8 w-8 items-center justify-center text-xs text-muted-foreground">
            —
          </span>
        )}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function MembersPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id

  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    try {
      setError(null)
      const result = await api.members.list(org.slug)
      setMembers(result.members)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, org.slug])

  useEffect(() => {
    load()
  }, [load])

  function handleRoleChange(id: string, newRole: string) {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role: newRole } : m)))
  }

  function handleRemoved(id: string) {
    setMembers((prev) => prev.filter((m) => m.id !== id))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-eyebrow mb-1.5">Workspace</p>
          <h1 className="page-title">Members</h1>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Invite collaborators and control who can change flags versus view-only access.
          </p>
        </div>
      </div>

      {!isAdmin && !loading && (
        <div
          className="mb-8 rounded-lg border border-border bg-muted/35 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          Only admins can manage members.
        </div>
      )}

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {!loading && !error && isAdmin && members.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">No members yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            People who join this organization will appear here. Promotion and removal
            controls are available to admins.
          </p>
        </div>
      )}

      {!loading && !error && members.length > 0 && (
        <div className="table-shell overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_2.5rem] gap-4 border-b border-border bg-muted/45 px-5 py-3 sm:grid dark:bg-muted/15">
            <span className="data-table-th">Member</span>
            <span className="data-table-th">Role</span>
            <span className="data-table-th">Joined</span>
            <span className="sr-only">Actions</span>
          </div>
          {members.map((member) => (
            <MemberRow
              key={member.id}
              orgSlug={org.slug}
              member={member}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              onRoleChange={handleRoleChange}
              onRemove={setRemoveTarget}
            />
          ))}
        </div>
      )}

      {removeTarget && (
        <RemoveMemberDialog
          orgSlug={org.slug}
          member={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={handleRemoved}
        />
      )}
    </div>
  )
}
