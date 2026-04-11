import { useState, useEffect, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import { Building2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

// ── Types ────────────────────────────────────────────────────────────────────

interface OrgRow {
  id: string
  name: string
  slug: string
  status: string
  createdAt: string
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchOrgs(): Promise<OrgRow[]> {
  const res = await fetch('/api/superadmin/orgs')
  if (!res.ok) throw new Error(`Failed to load organizations (${res.status})`)
  const data = await res.json()
  return data.orgs
}

async function deleteOrg(slug: string): Promise<void> {
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to delete organization')
  }
}

// ── Delete confirmation dialog ───────────────────────────────────────────────

function DeleteOrgDialog({
  org,
  onClose,
  onDeleted,
}: {
  org: OrgRow
  onClose: () => void
  onDeleted: (slug: string) => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteOrg(org.slug)
      onDeleted(org.slug)
      onClose()
      toast.success(`"${org.name}" deleted`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !deleting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete organization?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will permanently delete{' '}
          <strong>{org.name}</strong> ({org.slug}) and all its flags,
          environments, and members. This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete organization'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminOrgsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OrgRow | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await fetchOrgs()
      setOrgs(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organizations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleDeleted(slug: string) {
    setOrgs((prev) => prev.filter((o) => o.slug !== slug))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <Building2
            className="h-5 w-5 text-muted-foreground mt-0.5"
            strokeWidth={1.75}
          />
          <div>
            <p className="page-eyebrow">Super admin</p>
            <h1 className="page-title">Organizations</h1>
          </div>
        </div>
        <Link to="/admin/orgs/new">
          <Button size="sm" className="mt-1 shrink-0">
            <Plus className="h-4 w-4" />
            New organization
          </Button>
        </Link>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="surface-card divide-y divide-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && orgs.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Building2
              className="h-5 w-5 text-muted-foreground"
              strokeWidth={1.5}
            />
          </div>
          <h2 className="text-base font-medium text-foreground mb-1">
            No organizations yet
          </h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Create an organization to onboard your first tenant.
          </p>
          <Link to="/admin/orgs/new">
            <Button size="sm">
              <Plus className="h-4 w-4" />
              Create organization
            </Button>
          </Link>
        </div>
      )}

      {!loading && !error && orgs.length > 0 && (
        <div className="surface-card divide-y divide-border">
          {orgs.map((org) => (
            <div
              key={org.id}
              className="flex items-center gap-4 px-5 py-4 sm:px-6"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    to="/admin/orgs/$slug"
                    params={{ slug: org.slug }}
                    className="text-sm font-medium text-foreground hover:underline focus-visible:underline outline-none"
                  >
                    {org.name}
                  </Link>
                  <Badge
                    variant={org.status === 'suspended' ? 'destructive' : 'secondary'}
                    className="text-[0.65rem]"
                  >
                    {org.status}
                  </Badge>
                </div>
                <p className="text-[0.75rem] text-muted-foreground font-mono mt-0.5">
                  {org.slug}
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-3">
                <span className="text-[0.75rem] text-muted-foreground hidden sm:inline">
                  {new Date(org.createdAt).toLocaleDateString()}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDeleteTarget(org)}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                  aria-label={`Delete ${org.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteOrgDialog
          org={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
