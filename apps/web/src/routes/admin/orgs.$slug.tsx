import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { Link, useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

// ── Types ────────────────────────────────────────────────────────────────────

interface OrgDetail {
  id: string
  name: string
  slug: string
  status: string
  oktaClientId: string
  oktaClientSecret: string
  oktaIssuer: string
  createdAt: string
  memberCount: number
}

interface OrgPatch {
  id: string
  name: string
  slug: string
  status: string
  oktaClientId: string
  oktaClientSecret: string
  oktaIssuer: string
  createdAt: string
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchOrg(slug: string): Promise<OrgDetail> {
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Failed to load organization (${res.status})`)
  }
  const data = await res.json()
  return data.org
}

async function patchOrg(
  slug: string,
  body: Record<string, string>,
): Promise<OrgPatch> {
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to update organization')
  return data.org
}

async function suspendOrg(slug: string): Promise<string> {
  const res = await fetch(
    `/api/superadmin/orgs/${encodeURIComponent(slug)}/suspend`,
    { method: 'POST' },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to suspend organization')
  return data.status
}

async function unsuspendOrg(slug: string): Promise<string> {
  const res = await fetch(
    `/api/superadmin/orgs/${encodeURIComponent(slug)}/unsuspend`,
    { method: 'POST' },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to unsuspend organization')
  return data.status
}

async function deleteOrg(slug: string): Promise<void> {
  const res = await fetch(
    `/api/superadmin/orgs/${encodeURIComponent(slug)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to delete organization')
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminOrgDetailPage() {
  const { slug, orgSlug } = useParams({ strict: false }) as { slug: string; orgSlug: string }
  const navigate = useNavigate()

  const [org, setOrg] = useState<OrgDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form fields
  const [name, setName] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [oktaClientId, setOktaClientId] = useState('')
  const [oktaClientSecret, setOktaClientSecret] = useState('')
  const [oktaIssuer, setOktaIssuer] = useState('')
  const [saving, setSaving] = useState(false)

  const [suspending, setSuspending] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await fetchOrg(orgSlug)
      setOrg(result)
      setName(result.name)
      setEditSlug(result.slug)
      setOktaClientId(result.oktaClientId)
      setOktaClientSecret(result.oktaClientSecret)
      setOktaIssuer(result.oktaIssuer)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organization')
    } finally {
      setLoading(false)
    }
  }, [orgSlug])

  useEffect(() => {
    load()
  }, [load])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!org) return
    setSaving(true)
    try {
      const updated = await patchOrg(orgSlug, {
        name: name.trim(),
        slug: editSlug.trim(),
        oktaClientId: oktaClientId.trim(),
        oktaClientSecret: oktaClientSecret.trim(),
        oktaIssuer: oktaIssuer.trim(),
      })
      setOrg((prev) => (prev ? { ...prev, ...updated } : prev))
      toast.success('Organization updated')
      if (updated.slug !== orgSlug) {
        navigate({ to: '/org/$slug/admin/orgs/$orgSlug', params: { slug, orgSlug: updated.slug } })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update organization')
    } finally {
      setSaving(false)
    }
  }

  async function handleSuspend() {
    if (!org) return
    setSuspending(true)
    try {
      const status = await suspendOrg(orgSlug)
      setOrg((prev) => (prev ? { ...prev, status } : prev))
      toast.success('Organization suspended')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to suspend')
    } finally {
      setSuspending(false)
    }
  }

  async function handleUnsuspend() {
    if (!org) return
    setSuspending(true)
    try {
      const status = await unsuspendOrg(orgSlug)
      setOrg((prev) => (prev ? { ...prev, status } : prev))
      toast.success('Organization unsuspended')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unsuspend')
    } finally {
      setSuspending(false)
    }
  }

  async function handleDelete() {
    if (!org) return
    setDeleting(true)
    try {
      await deleteOrg(orgSlug)
      toast.success(`"${org.name}" deleted`)
      navigate({ to: '/org/$slug/admin', params: { slug } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete organization')
      setDeleting(false)
    }
  }

  if (loading) {
    return null
  }

  if (error || !org) {
    return (
      <div className="page-container page-container-wide page-enter">
        <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="page-eyebrow mb-1.5">Directory</p>
            <h1 className="page-title">Organization</h1>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              We couldn’t load this tenant.
            </p>
          </div>
          <Link
            to="/org/$slug/admin"
            params={{ slug }}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'default' }),
              'gap-2 shadow-surface-xs',
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to organizations
          </Link>
        </div>
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error ?? 'Organization not found'}
        </div>
      </div>
    )
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="page-eyebrow mb-1.5">Directory</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="page-title">{org.name}</h1>
            <Badge
              variant={org.status === 'suspended' ? 'destructive' : 'secondary'}
              className="h-6 px-2 text-[0.6875rem] font-medium capitalize"
            >
              {org.status}
            </Badge>
          </div>
          <p className="data-table-mono-meta mt-1">{org.slug}</p>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Manage tenant identity, Okta settings, and lifecycle for this organization.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          to="/org/$slug/admin"
          params={{ slug }}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'default' }),
            'gap-2 shadow-surface-xs',
          )}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to organizations
        </Link>
      </div>

      <div className="space-y-6">
        <form onSubmit={handleSave} className="space-y-6">
          <div className="table-shell overflow-hidden">
            <div className="border-b border-border bg-muted/45 px-5 py-3 dark:bg-muted/15">
              <span className="data-table-th">Organization details</span>
            </div>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <div className="space-y-1.5">
                <Label htmlFor="org-name">Name</Label>
                <Input
                  id="org-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="org-slug">Slug</Label>
                <Input
                  id="org-slug"
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="font-mono text-sm"
                  required
                />
                <p className="text-[0.75rem] text-muted-foreground">
                  Changing the slug will break existing bookmarks and URLs.
                </p>
              </div>
            </div>

            <div className="border-b border-border bg-muted/45 px-5 py-3 dark:bg-muted/15">
              <span className="data-table-th">Okta configuration</span>
            </div>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <div className="space-y-1.5">
                <Label htmlFor="okta-client-id">Client ID</Label>
                <Input
                  id="okta-client-id"
                  value={oktaClientId}
                  onChange={(e) => setOktaClientId(e.target.value)}
                  className="font-mono text-sm"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="okta-client-secret">Client Secret</Label>
                <Input
                  id="okta-client-secret"
                  type="password"
                  value={oktaClientSecret}
                  onChange={(e) => setOktaClientSecret(e.target.value)}
                  required
                  autoComplete="off"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="okta-issuer">Issuer URL</Label>
                <Input
                  id="okta-issuer"
                  value={oktaIssuer}
                  onChange={(e) => setOktaIssuer(e.target.value)}
                  className="font-mono text-sm"
                  required
                />
              </div>
            </div>
          </div>

          <div>
            <Button
              type="submit"
              disabled={saving}
              className="shadow-surface-xs"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>

        <div className="table-shell overflow-hidden">
          <div className="border-b border-border bg-muted/45 px-5 py-3 dark:bg-muted/15">
            <span className="data-table-th">Status</span>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-sm font-medium text-foreground">
                {org.status === 'suspended'
                  ? 'Unsuspend organization'
                  : 'Suspend organization'}
              </p>
              <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                {org.status === 'suspended'
                  ? 'Restores member access and SDK functionality.'
                  : 'Blocks all member access and SDK requests immediately.'}
              </p>
            </div>
            <Button
              variant={org.status === 'suspended' ? 'default' : 'outline'}
              size="sm"
              onClick={org.status === 'suspended' ? handleUnsuspend : handleSuspend}
              disabled={suspending}
              className="shrink-0"
            >
              {suspending
                ? '…'
                : org.status === 'suspended'
                  ? 'Unsuspend'
                  : 'Suspend'}
            </Button>
          </div>
        </div>

        <div className="table-shell overflow-hidden">
          <div className="border-b border-border bg-muted/45 px-5 py-3 dark:bg-muted/15">
            <span className={cn('data-table-th', 'text-destructive')}>
              Danger zone
            </span>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-sm font-medium text-foreground">
                Delete this organization
              </p>
              <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                Permanently removes the organization, all flags, environments,
                and members. This cannot be undone.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              className="shrink-0"
            >
              Delete
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onOpenChange={(v) => {
          if (!deleting) setDeleteOpen(v)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete organization?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete{' '}
            <span className="font-medium text-foreground">{org.name}</span> and
            all its flags, environments, and members. This cannot be undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete organization'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
