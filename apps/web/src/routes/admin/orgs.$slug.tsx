import { useState, useEffect, type FormEvent } from 'react'
import { Link, useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

async function patchOrg(slug: string, body: Record<string, string>): Promise<OrgDetail> {
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
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}/suspend`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to suspend organization')
  return data.status
}

async function unsuspendOrg(slug: string): Promise<string> {
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}/unsuspend`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to unsuspend organization')
  return data.status
}

async function deleteOrg(slug: string): Promise<void> {
  const res = await fetch(`/api/superadmin/orgs/${encodeURIComponent(slug)}`, { method: 'DELETE' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to delete organization')
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminOrgDetailPage() {
  const { slug, orgSlug } = useParams({ strict: false }) as { slug: string; orgSlug: string }
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Form fields — synced from query data on first load
  const [name, setName] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [oktaClientId, setOktaClientId] = useState('')
  const [oktaClientSecret, setOktaClientSecret] = useState('')
  const [oktaIssuer, setOktaIssuer] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: org, isLoading, error } = useQuery({
    queryKey: ['superadmin-org', orgSlug],
    queryFn: () => fetchOrg(orgSlug),
  })

  useEffect(() => {
    if (org) {
      setName(org.name)
      setEditSlug(org.slug)
      setOktaClientId(org.oktaClientId)
      setOktaClientSecret(org.oktaClientSecret)
      setOktaIssuer(org.oktaIssuer)
    }
  }, [org])

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, string>) => patchOrg(orgSlug, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['superadmin-org', updated.slug], updated)
      queryClient.invalidateQueries({ queryKey: ['superadmin-orgs'] })
      toast.success('Organization updated')
      if (updated.slug !== orgSlug) {
        navigate({ to: '/org/$slug/admin/orgs/$orgSlug', params: { slug, orgSlug: updated.slug } })
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update organization'),
  })

  const suspendMutation = useMutation({
    mutationFn: () => suspendOrg(orgSlug),
    onSuccess: (status) => {
      queryClient.setQueryData<OrgDetail>(['superadmin-org', orgSlug], (old) =>
        old ? { ...old, status } : old,
      )
      toast.success('Organization suspended')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to suspend'),
  })

  const unsuspendMutation = useMutation({
    mutationFn: () => unsuspendOrg(orgSlug),
    onSuccess: (status) => {
      queryClient.setQueryData<OrgDetail>(['superadmin-org', orgSlug], (old) =>
        old ? { ...old, status } : old,
      )
      toast.success('Organization unsuspended')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to unsuspend'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteOrg(orgSlug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superadmin-orgs'] })
      toast.success(`"${org?.name}" deleted`)
      navigate({ to: '/org/$slug/admin', params: { slug } })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete organization')
      setDeleteOpen(false)
    },
  })

  function handleSave(e: FormEvent) {
    e.preventDefault()
    saveMutation.mutate({
      name: name.trim(),
      slug: editSlug.trim(),
      oktaClientId: oktaClientId.trim(),
      oktaClientSecret: oktaClientSecret.trim(),
      oktaIssuer: oktaIssuer.trim(),
    })
  }

  if (isLoading) return null

  if (error || !org) {
    return (
      <div className="page-container page-container-wide page-enter">
        <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="page-eyebrow mb-1.5">Directory</p>
            <h1 className="page-title">Organization</h1>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              We couldn't load this tenant.
            </p>
          </div>
          <Link
            to="/org/$slug/admin"
            params={{ slug }}
            className={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'gap-2 shadow-surface-xs')}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to organizations
          </Link>
        </div>
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error instanceof Error ? error.message : 'Organization not found'}
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
          className={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'gap-2 shadow-surface-xs')}
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
                <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required />
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
            <Button type="submit" disabled={saveMutation.isPending} className="shadow-surface-xs">
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
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
                {org.status === 'suspended' ? 'Unsuspend organization' : 'Suspend organization'}
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
              onClick={() => org.status === 'suspended' ? unsuspendMutation.mutate() : suspendMutation.mutate()}
              disabled={suspendMutation.isPending || unsuspendMutation.isPending}
              className="shrink-0"
            >
              {suspendMutation.isPending || unsuspendMutation.isPending
                ? '…'
                : org.status === 'suspended'
                  ? 'Unsuspend'
                  : 'Suspend'}
            </Button>
          </div>
        </div>

        {orgSlug !== slug && (
          <div className="table-shell overflow-hidden">
            <div className="border-b border-border bg-muted/45 px-5 py-3 dark:bg-muted/15">
              <span className={cn('data-table-th', 'text-destructive')}>Danger zone</span>
            </div>
            <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <p className="text-sm font-medium text-foreground">Delete this organization</p>
                <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                  Permanently removes the organization, all flags, environments, and members. This cannot be undone.
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
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={(v) => { if (!deleteMutation.isPending) setDeleteOpen(v) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete organization?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{org.name}</strong> and all its flags, environments, and members. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete organization'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
