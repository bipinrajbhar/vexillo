import { useState, useEffect, useCallback } from 'react'
import { Boxes, Plus, RefreshCw, Trash2, X, Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useOrg } from '@/lib/org-context'
import { api, type EnvRow } from '@/lib/api-client'

// ── Create Environment Dialog ────────────────────────────────────────────────

function CreateEnvDialog({
  orgSlug,
  open,
  onOpenChange,
  onCreated,
}: {
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (env: EnvRow, apiKey: string) => void
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const result = await api.environments.create(orgSlug, name.trim())
      onCreated(result.environment, result.apiKey)
      onOpenChange(false)
      setName('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create environment')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenChange(value: boolean) {
    if (!submitting) {
      onOpenChange(value)
      if (!value) setName('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New environment</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="env-name">Name</Label>
            <Input
              id="env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production"
              required
              autoFocus
            />
            <p className="text-[0.75rem] text-muted-foreground">
              A slug will be auto-generated from the name.
            </p>
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
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create environment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── New API Key Dialog ────────────────────────────────────────────────────────

function NewApiKeyDialog({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>API key generated</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Copy this key now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all">
              {apiKey}
            </code>
            <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Delete Confirmation Dialog ────────────────────────────────────────────────

function DeleteEnvDialog({
  orgSlug,
  env,
  onClose,
  onDeleted,
}: {
  orgSlug: string
  env: EnvRow
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.environments.delete(orgSlug, env.id)
      onDeleted(env.id)
      onClose()
      toast.success(`Environment "${env.name}" deleted`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete environment')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !deleting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete environment?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Deleting <strong>{env.name}</strong> will remove all its flag states and API keys. This
          cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete environment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Allowed Origins Editor ────────────────────────────────────────────────────

function AllowedOriginsEditor({
  orgSlug,
  env,
  onUpdated,
  disabled,
}: {
  orgSlug: string
  env: EnvRow
  onUpdated: (id: string, origins: string[]) => void
  disabled: boolean
}) {
  const [origins, setOrigins] = useState<string[]>(env.allowedOrigins)
  const [newOrigin, setNewOrigin] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleAdd() {
    const trimmed = newOrigin.trim()
    if (!trimmed || origins.includes(trimmed)) return
    const next = [...origins, trimmed]
    setOrigins(next)
    setNewOrigin('')
    await save(next)
  }

  async function handleRemove(origin: string) {
    const next = origins.filter((o) => o !== origin)
    setOrigins(next)
    await save(next)
  }

  async function save(next: string[]) {
    setSaving(true)
    try {
      await api.environments.patch(orgSlug, env.id, next)
      onUpdated(env.id, next)
    } catch (err) {
      setOrigins(env.allowedOrigins)
      toast.error(err instanceof Error ? err.message : 'Failed to update allowed origins')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Allowed origins
      </p>
      {origins.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">None — all cross-origin requests blocked</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {origins.map((origin) => (
            <Badge key={origin} variant="secondary" className="gap-1 font-mono text-[0.7rem]">
              {origin}
              {!disabled && (
                <button
                  onClick={() => handleRemove(origin)}
                  disabled={saving}
                  className="ml-0.5 rounded hover:text-destructive focus-visible:outline-none"
                  aria-label={`Remove ${origin}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="flex items-center gap-2 mt-1">
          <Input
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            placeholder="https://example.com or *"
            className="h-7 text-xs font-mono"
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleAdd() }
            }}
            disabled={saving}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={saving || !newOrigin.trim()}
            className="h-7 text-xs px-2 shrink-0"
          >
            Add
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Environment card ──────────────────────────────────────────────────────────

function EnvironmentCard({
  orgSlug,
  env,
  isAdmin,
  onRotateKey,
  onDelete,
  onOriginsUpdated,
}: {
  orgSlug: string
  env: EnvRow
  isAdmin: boolean
  onRotateKey: (apiKey: string) => void
  onDelete: (env: EnvRow) => void
  onOriginsUpdated: (id: string, origins: string[]) => void
}) {
  const [rotating, setRotating] = useState(false)

  async function handleRotate() {
    setRotating(true)
    try {
      const { apiKey: key } = await api.environments.rotateKey(orgSlug, env.id)
      onRotateKey(key)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate key')
    } finally {
      setRotating(false)
    }
  }

  return (
    <div className="surface-card">
      <div className="px-5 py-4 sm:px-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-foreground">{env.name}</h2>
            <code className="text-[0.7rem] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
              {env.slug}
            </code>
          </div>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRotate}
              disabled={rotating}
              className="h-7 text-xs gap-1.5"
            >
              <RefreshCw className={`h-3 w-3 ${rotating ? 'animate-spin' : ''}`} />
              Rotate key
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDelete(env)}
              className="h-7 text-xs text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/50"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border px-5 py-4 sm:px-6 space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            API key
          </p>
          {env.keyHint ? (
            <code className="text-xs font-mono text-foreground">{env.keyHint}</code>
          ) : (
            <p className="text-xs text-muted-foreground italic">No key — rotate to generate one</p>
          )}
        </div>

        <AllowedOriginsEditor
          orgSlug={orgSlug}
          env={env}
          onUpdated={onOriginsUpdated}
          disabled={!isAdmin}
        />
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function EnvironmentsPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'

  const [envs, setEnvs] = useState<EnvRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingApiKey, setPendingApiKey] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EnvRow | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await api.environments.list(org.slug).then((r) => r.environments)
      setEnvs(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load environments')
    } finally {
      setLoading(false)
    }
  }, [org.slug])

  useEffect(() => {
    load()
  }, [load])

  function handleCreated(env: EnvRow, apiKey: string) {
    setEnvs((prev) => [...prev, env])
    setPendingApiKey(apiKey)
    toast.success(`Environment "${env.name}" created`)
  }

  function handleRotateKey(apiKey: string) {
    setPendingApiKey(apiKey)
  }

  function handleDeleted(id: string) {
    setEnvs((prev) => prev.filter((e) => e.id !== id))
  }

  function handleOriginsUpdated(id: string, origins: string[]) {
    setEnvs((prev) => prev.map((e) => (e.id === id ? { ...e, allowedOrigins: origins } : e)))
  }

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <Boxes className="h-5 w-5 text-muted-foreground mt-0.5" strokeWidth={1.75} />
          <div>
            <p className="page-eyebrow">Settings</p>
            <h1 className="page-title">Environments</h1>
          </div>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)} size="sm" className="mt-1 shrink-0">
            <Plus className="h-4 w-4" />
            New environment
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="surface-card px-5 py-4 sm:px-6 space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && envs.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Boxes className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h2 className="text-base font-medium text-foreground mb-1">No environments yet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Environments let you manage separate flag states for production, staging, and development.
          </p>
          {isAdmin && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-4 w-4" />
              Create your first environment
            </Button>
          )}
        </div>
      )}

      {!loading && !error && envs.length > 0 && (
        <div className="space-y-4">
          {envs.map((env) => (
            <EnvironmentCard
              key={env.id}
              orgSlug={org.slug}
              env={env}
              isAdmin={isAdmin}
              onRotateKey={handleRotateKey}
              onDelete={setDeleteTarget}
              onOriginsUpdated={handleOriginsUpdated}
            />
          ))}
        </div>
      )}

      <CreateEnvDialog
        orgSlug={org.slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      {pendingApiKey && (
        <NewApiKeyDialog apiKey={pendingApiKey} onClose={() => setPendingApiKey(null)} />
      )}

      {deleteTarget && (
        <DeleteEnvDialog
          orgSlug={org.slug}
          env={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
