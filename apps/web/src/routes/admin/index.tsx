import { useState, useEffect, useCallback } from 'react'
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AdminNewOrgDialog } from '@/components/admin-new-org-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
          <DialogDescription>
            This will permanently delete <strong>{org.name}</strong> ({org.slug}) and all its flags, environments, and members. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
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
  const navigate = useNavigate()
  const location = useLocation()
  const { slug } = useParams({ strict: false }) as { slug: string }
  const [orgs, setOrgs] = useState<OrgRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OrgRow | null>(null)
  const [newOrgOpen, setNewOrgOpen] = useState(false)

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

  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const flag = q.get('newOrg')
    if (flag === '1' || flag === 'true') {
      setNewOrgOpen(true)
      navigate({ to: '/org/$slug/admin', params: { slug }, replace: true })
    }
  }, [location.search, navigate])

  function handleDeleted(slug: string) {
    setOrgs((prev) => prev.filter((o) => o.slug !== slug))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-eyebrow mb-1.5">Directory</p>
          <h1 className="page-title">Organizations</h1>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Manage tenant workspaces, Okta settings, and lifecycle from one place.
          </p>
        </div>
        <Button
          size="default"
          className="gap-2 shadow-surface-xs"
          onClick={() => setNewOrgOpen(true)}
        >
          <Plus className="h-4 w-4" />
          New organization
        </Button>
      </div>

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && orgs.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">
            No organizations yet
          </p>
          <p className="mb-8 max-w-sm text-sm text-muted-foreground">
            Create an organization to onboard your first tenant and configure Okta.
          </p>
          <Button className="gap-2 shadow-surface-xs" onClick={() => setNewOrgOpen(true)}>
            <Plus className="h-4 w-4" />
            Create organization
          </Button>
        </div>
      )}

      {/* List */}
      {!loading && !error && orgs.length > 0 && (
        <div className="table-shell overflow-hidden">
          <div className="hidden grid-cols-[1fr_6.5rem_7.5rem_2.5rem] gap-4 border-b border-border bg-muted/45 px-5 py-3 sm:grid dark:bg-muted/15">
            <span className="data-table-th">Organization</span>
            <span className="data-table-th">Status</span>
            <span className="data-table-th">Created</span>
            <span className="sr-only">Actions</span>
          </div>

          {orgs.map((org) => (
            <div
              key={org.id}
              className="data-table-body-row grid grid-cols-[1fr_auto] gap-4 border-b border-border px-5 py-4 last:border-0 sm:grid-cols-[1fr_6.5rem_7.5rem_2.5rem] sm:items-center sm:px-6"
            >
              <div className="min-w-0">
                <Link
                  to="/org/$slug/admin/orgs/$orgSlug"
                  params={{ slug, orgSlug: org.slug }}
                  className="data-table-primary-label text-[0.9375rem] hover:underline focus-visible:underline"
                >
                  {org.name}
                </Link>
                <p className="data-table-mono-meta mt-0.5 text-[0.8125rem]">
                  {org.slug}
                </p>
              </div>

              <div className="hidden sm:flex sm:items-center">
                <Badge
                  variant={
                    org.status === 'suspended' ? 'destructive' : 'secondary'
                  }
                  className="h-6 px-2 text-[0.6875rem] font-medium capitalize"
                >
                  {org.status}
                </Badge>
              </div>

              <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">
                {new Date(org.createdAt).toLocaleDateString()}
              </span>

              <div className="flex justify-end sm:justify-start">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeleteTarget(org)}
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${org.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="col-span-2 flex flex-wrap items-center gap-2 sm:hidden">
                <Badge
                  variant={
                    org.status === 'suspended' ? 'destructive' : 'secondary'
                  }
                  className="h-6 px-2 text-[0.6875rem] font-medium capitalize"
                >
                  {org.status}
                </Badge>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {new Date(org.createdAt).toLocaleDateString()}
                </span>
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

      <AdminNewOrgDialog open={newOrgOpen} onOpenChange={setNewOrgOpen} />
    </div>
  )
}
