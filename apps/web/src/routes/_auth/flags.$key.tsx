import { useState, useEffect, useCallback } from 'react'
import { useParams, Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Flag, Pencil, Check, X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { authClient } from '@/lib/auth-client'

// ── Types ────────────────────────────────────────────────────────────────────

interface FlagRow {
  id: string
  name: string
  key: string
  description: string
  createdAt: string
  states: Record<string, boolean>
}

interface Env {
  id: string
  name: string
  slug: string
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchFlagDetail(key: string): Promise<{ flag: FlagRow; environments: Env[] }> {
  const res = await fetch('/api/dashboard/flags')
  if (!res.ok) throw new Error(`Failed to load flags (${res.status})`)
  const data = await res.json()
  const flag = (data.flags as FlagRow[]).find((f) => f.key === key)
  if (!flag) throw new Error('Flag not found')
  return { flag, environments: data.environments }
}

async function patchFlag(
  key: string,
  body: { name?: string; description?: string },
): Promise<FlagRow> {
  const res = await fetch(`/api/dashboard/flags/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to update flag')
  return data.flag
}

async function deleteFlag(key: string): Promise<void> {
  const res = await fetch(`/api/dashboard/flags/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to delete flag')
  }
}

async function toggleFlag(key: string, environmentId: string): Promise<boolean> {
  const res = await fetch(`/api/dashboard/flags/${encodeURIComponent(key)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environmentId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to toggle flag')
  return data.enabled
}

// ── Inline edit field ────────────────────────────────────────────────────────

function EditableField({
  label,
  value,
  multiline,
  onSave,
  disabled,
}: {
  label: string
  value: string
  multiline?: boolean
  onSave: (value: string) => Promise<void>
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (draft.trim() === value) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(draft.trim())
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </Label>
        {multiline ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
            className="text-sm"
          />
        ) : (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') handleCancel()
            }}
          />
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !draft.trim()}>
            <Check className="h-3.5 w-3.5" />
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saving}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/field space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <p className={`flex-1 text-sm text-foreground leading-relaxed ${!value ? 'text-muted-foreground italic' : ''}`}>
          {value || 'No description'}
        </p>
        {!disabled && (
          <button
            onClick={() => { setDraft(value); setEditing(true) }}
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover/field:opacity-100 transition-opacity hover:text-foreground focus-visible:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Edit ${label.toLowerCase()}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function FlagDetailPage() {
  const { key } = useParams({ from: '/auth/flags/$key' })
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const isAdmin = (session?.user as { role?: string | null } | undefined)?.role === 'admin'

  const [flag, setFlag] = useState<FlagRow | null>(null)
  const [environments, setEnvironments] = useState<Env[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await fetchFlagDetail(key)
      setFlag(result.flag)
      setEnvironments(result.environments)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flag')
    } finally {
      setLoading(false)
    }
  }, [key])

  useEffect(() => {
    load()
  }, [load])

  function handleToggle(envId: string, envSlug: string) {
    if (!flag) return

    // Optimistic update
    setFlag((prev) =>
      prev ? { ...prev, states: { ...prev.states, [envSlug]: !prev.states[envSlug] } } : prev,
    )

    toggleFlag(key, envId).then((enabled) => {
      setFlag((prev) =>
        prev ? { ...prev, states: { ...prev.states, [envSlug]: enabled } } : prev,
      )
    }).catch((err) => {
      // Roll back
      setFlag((prev) =>
        prev ? { ...prev, states: { ...prev.states, [envSlug]: !prev.states[envSlug] } } : prev,
      )
      toast.error(err instanceof Error ? err.message : 'Failed to toggle flag')
    })
  }

  async function handleSaveName(name: string) {
    const updated = await patchFlag(key, { name })
    setFlag((prev) => (prev ? { ...prev, name: updated.name } : prev))
    toast.success('Name updated')
  }

  async function handleSaveDescription(description: string) {
    const updated = await patchFlag(key, { description })
    setFlag((prev) => (prev ? { ...prev, description: updated.description } : prev))
    toast.success('Description updated')
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteFlag(key)
      toast.success(`Flag "${flag?.name}" deleted`)
      navigate({ to: '/' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete flag')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container page-container-narrow">
        <Skeleton className="h-4 w-20 mb-8" />
        <div className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    )
  }

  if (error || !flag) {
    return (
      <div className="page-container page-container-narrow">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to flags
        </Link>
        <p className="text-sm text-destructive">{error ?? 'Flag not found'}</p>
      </div>
    )
  }

  const enabledCount = environments.filter((e) => flag.states[e.slug]).length

  return (
    <div className="page-container page-container-narrow page-enter">
      {/* Back link */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8 focus-visible:underline outline-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to flags
      </Link>

      {/* Flag header */}
      <div className="flex items-start gap-3 mb-8">
        <Flag className="h-5 w-5 text-muted-foreground mt-1 shrink-0" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="page-eyebrow mb-1">Feature flag</p>
          <h1 className="page-title">{flag.name}</h1>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <code className="text-[0.75rem] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
              {flag.key}
            </code>
            {environments.length > 0 && (
              <Badge variant="secondary" className="text-[0.7rem]">
                {enabledCount}/{environments.length} envs on
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* Details card */}
        <div className="surface-card px-5 py-5 sm:px-6 space-y-5">
          <h2 className="text-[0.8125rem] font-semibold text-foreground">Details</h2>
          <EditableField
            label="Name"
            value={flag.name}
            onSave={handleSaveName}
            disabled={!isAdmin}
          />
          <EditableField
            label="Description"
            value={flag.description}
            multiline
            onSave={handleSaveDescription}
            disabled={!isAdmin}
          />
        </div>

        {/* Environments card */}
        <div className="surface-card overflow-hidden">
          <div className="px-5 py-4 sm:px-6 border-b border-border">
            <h2 className="text-[0.8125rem] font-semibold text-foreground">Environments</h2>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground mt-0.5">
                View-only — you need admin access to toggle flags.
              </p>
            )}
          </div>

          {environments.length === 0 ? (
            <div className="px-5 py-8 sm:px-6 text-center">
              <p className="text-sm text-muted-foreground">
                No environments yet.{' '}
                <Link to="/environments" className="underline underline-offset-2">
                  Create one
                </Link>{' '}
                to start using this flag.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {environments.map((env) => {
                const enabled = !!flag.states[env.slug]
                return (
                  <div key={env.id} className="flex items-center justify-between px-5 py-4 sm:px-6">
                    <div>
                      <p className="text-sm font-medium text-foreground">{env.name}</p>
                      <p className="text-[0.75rem] text-muted-foreground font-mono">{env.slug}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-[0.75rem] font-medium ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}
                      >
                        {enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggle(env.id, env.slug)}
                        disabled={!isAdmin}
                        aria-label={`Toggle ${flag.name} in ${env.name}`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Danger zone */}
        {isAdmin && (
          <div className="surface-card px-5 py-5 sm:px-6">
            <h2 className="text-[0.8125rem] font-semibold text-destructive mb-3">Danger zone</h2>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Delete this flag</p>
                <p className="text-[0.75rem] text-muted-foreground mt-0.5">
                  Permanently removes the flag and all its environment states. This cannot be undone.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                className="shrink-0"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={(v) => { if (!deleting) setDeleteOpen(v) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete flag?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete <span className="font-medium text-foreground">{flag.name}</span> and
            remove it from all environments. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete flag'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
