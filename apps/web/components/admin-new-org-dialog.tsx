import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function createOrg(body: {
  name: string
  slug: string
  oktaClientId: string
  oktaClientSecret: string
  oktaIssuer: string
}): Promise<{ slug: string }> {
  const res = await fetch('/api/superadmin/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to create organization')
  return data.org
}

export function AdminNewOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { slug: contextSlug } = useParams({ strict: false }) as { slug: string }
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [oktaClientId, setOktaClientId] = useState('')
  const [oktaClientSecret, setOktaClientSecret] = useState('')
  const [oktaIssuer, setOktaIssuer] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setName('')
      setSlug('')
      setSlugEdited(false)
      setOktaClientId('')
      setOktaClientSecret('')
      setOktaIssuer('')
      setSubmitting(false)
    }
  }, [open])

  function handleNameChange(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugify(value))
  }

  function handleSlugChange(value: string) {
    setSlug(value)
    setSlugEdited(true)
  }

  function handleOpenChange(value: boolean) {
    if (!submitting) onOpenChange(value)
  }

  const canSubmit =
    name.trim() &&
    slug.trim() &&
    oktaClientId.trim() &&
    oktaClientSecret.trim() &&
    oktaIssuer.trim()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const org = await createOrg({
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        oktaClientId: oktaClientId.trim(),
        oktaClientSecret: oktaClientSecret.trim(),
        oktaIssuer: oktaIssuer.trim(),
      })
      toast.success(`"${name.trim()}" created`)
      onOpenChange(false)
      navigate({ to: '/org/$slug/admin/orgs/$orgSlug', params: { slug: contextSlug, orgSlug: org.slug } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create organization')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="max-h-[min(90dvh,40rem)] overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-new-org-name">Name</Label>
            <Input
              id="admin-new-org-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Acme Corp"
              required
              autoFocus={open}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-new-org-slug">URL slug</Label>
            <Input
              id="admin-new-org-slug"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="e.g. acme-corp"
              className="font-mono text-sm"
              disabled={submitting}
            />
            <p className="text-[0.75rem] text-muted-foreground">
              Appears in routes and APIs. Auto-derived from the name until you edit it.
            </p>
          </div>

          <Separator className="bg-border/80" />

          <div className="space-y-1.5">
            <Label htmlFor="admin-new-org-okta-client-id">Client ID</Label>
            <Input
              id="admin-new-org-okta-client-id"
              value={oktaClientId}
              onChange={(e) => setOktaClientId(e.target.value)}
              placeholder="0oa..."
              required
              className="font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-new-org-okta-client-secret">Client secret</Label>
            <Input
              id="admin-new-org-okta-client-secret"
              type="password"
              value={oktaClientSecret}
              onChange={(e) => setOktaClientSecret(e.target.value)}
              required
              disabled={submitting}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-new-org-okta-issuer">Issuer URL</Label>
            <Input
              id="admin-new-org-okta-issuer"
              value={oktaIssuer}
              onChange={(e) => setOktaIssuer(e.target.value)}
              placeholder="https://your-org.okta.com/oauth2/default"
              required
              className="font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !canSubmit}
              className="shadow-surface-xs"
            >
              {submitting ? 'Creating…' : 'Create organization'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
