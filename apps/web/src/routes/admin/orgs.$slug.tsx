import { useState, useEffect, useCallback } from 'react'
import { Link, useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  const { slug } = useParams({ strict: false }) as { slug: string }
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
      const result = await fetchOrg(slug)
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
  }, [slug])

  useEffect(() => {
    load()
  }, [load])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!org) return
    setSaving(true)
    try {
      const updated = await patchOrg(org.slug, {
        name: name.trim(),
        slug: editSlug.trim(),
        oktaClientId: oktaClientId.trim(),
        oktaClientSecret: oktaClientSecret.trim(),
        oktaIssuer: oktaIssuer.trim(),
      })
      setOrg((prev) => (prev ? { ...prev, ...updated } : prev))
      toast.success('Organization updated')
      if (updated.slug !== org.slug) {
        navigate({ to: '/admin/orgs/$slug', params: { slug: updated.slug } })
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
      const status = await suspendOrg(org.slug)
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
      const status = await unsuspendOrg(org.slug)
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
      await deleteOrg(org.slug)
      toast.success(`"${org.name}" deleted`)
      navigate({ to: '/admin' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete organization')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container page-container-narrow">
        <Skeleton className="h-4 w-36 mb-8" />
        <div className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    )
  }

  if (error || !org) {
    return (
      <div className="page-container page-container-narrow">
        <Link
          to="/admin"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8 outline-none"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to organizations
        </Link>
        <p className="text-sm text-destructive">{error ?? 'Organization not found'}</p>
      </div>
    )
  }

  return (
    <div className="page-container page-container-narrow page-enter">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8 focus-visible:underline outline-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to organizations
      </Link>

      <div className="flex items-start gap-3 mb-8">
        <Building2
          className="h-5 w-5 text-muted-foreground mt-1 shrink-0"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="page-eyebrow mb-1">Super admin</p>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="page-title">{org.name}</h1>
            <Badge
              variant={org.status === 'suspended' ? 'destructive' : 'secondary'}
              className="text-xs capitalize"
            >
              {org.status}
            </Badge>
          </div>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <code className="text-[0.75rem] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
              {org.slug}
            </code>
            <span className="text-[0.75rem] text-muted-foreground">
              {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* Edit form */}
        <form onSubmit={handleSave} className="space-y-5">
          <div className="surface-card px-5 py-5 sm:px-6 space-y-5">
            <h2 className="text-[0.8125rem] font-semibold text-foreground">
              Organization details
            </h2>

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

          <div className="surface-card px-5 py-5 sm:px-6 space-y-5">
            <h2 className="text-[0.8125rem] font-semibold text-foreground">
              Okta configuration
            </h2>

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

          <div>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>

        {/* Suspend / Unsuspend */}
        <div className="surface-card px-5 py-5 sm:px-6">
          <h2 className="text-[0.8125rem] font-semibold text-foreground mb-3">
            Status
          </h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                {org.status === 'suspended'
                  ? 'Unsuspend organization'
                  : 'Suspend organization'}
              </p>
              <p className="text-[0.75rem] text-muted-foreground mt-0.5">
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

        {/* Danger zone */}
        <div className="surface-card px-5 py-5 sm:px-6">
          <h2 className="text-[0.8125rem] font-semibold text-destructive mb-3">
            Danger zone
          </h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                Delete this organization
              </p>
              <p className="text-[0.75rem] text-muted-foreground mt-0.5">
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
