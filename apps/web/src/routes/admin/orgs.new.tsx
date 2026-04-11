import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// ── API helpers ──────────────────────────────────────────────────────────────

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

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminOrgsNewPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [oktaClientId, setOktaClientId] = useState('')
  const [oktaClientSecret, setOktaClientSecret] = useState('')
  const [oktaIssuer, setOktaIssuer] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function handleNameChange(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugify(value))
  }

  function handleSlugChange(value: string) {
    setSlug(value)
    setSlugEdited(true)
  }

  const canSubmit =
    name.trim() &&
    slug.trim() &&
    oktaClientId.trim() &&
    oktaClientSecret.trim() &&
    oktaIssuer.trim()

  async function handleSubmit(e: React.FormEvent) {
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
      toast.success(`"${name}" created`)
      navigate({ to: '/admin/orgs/$slug', params: { slug: org.slug } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create organization')
      setSubmitting(false)
    }
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

      <div className="flex items-center gap-3 mb-8">
        <Building2
          className="h-5 w-5 text-muted-foreground"
          strokeWidth={1.75}
        />
        <div>
          <p className="page-eyebrow">Super admin</p>
          <h1 className="page-title">New organization</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="surface-card px-5 py-5 sm:px-6 space-y-5">
          <h2 className="text-[0.8125rem] font-semibold text-foreground">
            Organization details
          </h2>

          <div className="space-y-1.5">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Acme Corp"
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="org-slug">Slug</Label>
            <Input
              id="org-slug"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="e.g. acme-corp"
              className="font-mono text-sm"
            />
            <p className="text-[0.75rem] text-muted-foreground">
              Used in URLs and API routes. Auto-derived from name.
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
              placeholder="0oa..."
              required
              className="font-mono text-sm"
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
              placeholder="https://your-org.okta.com"
              required
              className="font-mono text-sm"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={submitting || !canSubmit}>
            {submitting ? 'Creating…' : 'Create organization'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate({ to: '/admin' })}
            disabled={submitting}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
