import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { Flag, Plus, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useOrg } from '@/lib/org-context'
import { api, type FlagRow, type EnvRef as Env } from '@/lib/api-client'

// ── Types ────────────────────────────────────────────────────────────────────

interface FlagsData {
  flags: FlagRow[]
  environments: Env[]
}

// ── Create Flag Dialog ───────────────────────────────────────────────────────

function CreateFlagDialog({
  orgSlug,
  open,
  onOpenChange,
  onCreated,
}: {
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (flag: FlagRow, envs: Env[]) => void
}) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  function slugify(s: string) {
    return s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  function handleNameChange(value: string) {
    setName(value)
    if (!keyEdited) setKey(slugify(value))
  }

  function handleKeyChange(value: string) {
    setKey(value)
    setKeyEdited(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return

    setSubmitting(true)
    try {
      const { flag } = await api.flags.create(orgSlug, { name: name.trim(), key: key.trim() || slugify(name), description: description.trim() })
      const data = await api.flags.list(orgSlug)
      onCreated(flag, data.environments)
      onOpenChange(false)
      setName('')
      setKey('')
      setDescription('')
      setKeyEdited(false)
      toast.success(`Flag "${flag.name}" created`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create flag')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenChange(value: boolean) {
    if (!submitting) {
      onOpenChange(value)
      if (!value) {
        setName('')
        setKey('')
        setDescription('')
        setKeyEdited(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New feature flag</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="flag-name">Name</Label>
            <Input
              id="flag-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. New checkout flow"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-key">Key</Label>
            <Input
              id="flag-key"
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="e.g. new_checkout_flow"
              className="font-mono text-sm"
            />
            <p className="text-[0.75rem] text-muted-foreground">
              Unique identifier used in code. Auto-derived from name if left empty.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-description">
              Description{' '}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="flag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this flag control?"
              rows={2}
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
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create flag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Flags table row ──────────────────────────────────────────────────────────

function FlagTableRow({
  flag,
  environments,
  orgSlug,
  isAdmin,
  onToggle,
}: {
  flag: FlagRow
  environments: Env[]
  orgSlug: string
  isAdmin: boolean
  onToggle: (flagKey: string, envId: string, envSlug: string) => void
}) {
  const enabledCount = environments.filter((e) => flag.states[e.slug]).length

  return (
    <tr className="group border-b border-border last:border-0">
      <td className="py-3.5 pl-5 pr-4 sm:pl-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to="/org/$slug/flags/$key"
              params={{ slug: orgSlug, key: flag.key }}
              className="font-medium text-foreground hover:underline focus-visible:underline outline-none"
            >
              {flag.name}
            </Link>
            <div className="mt-0.5 flex items-center gap-2">
              <code className="text-[0.7rem] text-muted-foreground font-mono bg-muted px-1 py-0.5 rounded-sm">
                {flag.key}
              </code>
              {environments.length > 0 && (
                <span className="text-[0.7rem] text-muted-foreground">
                  {enabledCount}/{environments.length} envs on
                </span>
              )}
            </div>
            {flag.description && (
              <p className="mt-0.5 text-[0.8125rem] text-muted-foreground truncate max-w-xs">
                {flag.description}
              </p>
            )}
          </div>
        </div>
      </td>

      {environments.map((env) => (
        <td key={env.id} className="px-4 py-3.5 text-center">
          <Switch
            checked={!!flag.states[env.slug]}
            onCheckedChange={() => onToggle(flag.key, env.id, env.slug)}
            disabled={!isAdmin}
            aria-label={`${flag.name} in ${env.name}`}
          />
        </td>
      ))}

      <td className="py-3.5 pr-4 text-right sm:pr-5">
        <Link
          to="/org/$slug/flags/$key"
          params={{ slug: orgSlug, key: flag.key }}
          className="inline-flex items-center justify-center rounded-sm p-1 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground focus-visible:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${flag.name}`}
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function FlagsPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'

  const [data, setData] = useState<FlagsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await api.flags.list(org.slug)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flags')
    } finally {
      setLoading(false)
    }
  }, [org.slug])

  useEffect(() => {
    load()
  }, [load])

  function handleToggle(flagKey: string, envId: string, envSlug: string) {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        flags: prev.flags.map((f) =>
          f.key === flagKey
            ? { ...f, states: { ...f.states, [envSlug]: !f.states[envSlug] } }
            : f,
        ),
      }
    })

    api.flags.toggle(org.slug, flagKey, envId).then(({ enabled }) => {
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          flags: prev.flags.map((f) =>
            f.key === flagKey
              ? { ...f, states: { ...f.states, [envSlug]: enabled } }
              : f,
          ),
        }
      })
    }).catch((err) => {
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          flags: prev.flags.map((f) =>
            f.key === flagKey
              ? { ...f, states: { ...f.states, [envSlug]: !f.states[envSlug] } }
              : f,
          ),
        }
      })
      toast.error(err instanceof Error ? err.message : 'Failed to toggle flag')
    })
  }

  function handleCreated(flag: FlagRow, envs: Env[]) {
    setData((prev) => {
      const environments = envs
      const newFlag: FlagRow = {
        ...flag,
        states: Object.fromEntries(environments.map((e) => [e.slug, false])),
      }
      return {
        flags: [newFlag, ...(prev?.flags ?? [])],
        environments,
      }
    })
  }

  const environments = data?.environments ?? []
  const flagsList = data?.flags ?? []

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <Flag className="h-5 w-5 text-muted-foreground mt-0.5" strokeWidth={1.75} />
          <div>
            <p className="page-eyebrow">Dashboard</p>
            <h1 className="page-title">Feature flags</h1>
          </div>
        </div>
        {isAdmin && (
          <div className="mt-1 shrink-0 flex flex-col items-end gap-1">
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              disabled={!loading && environments.length === 0}
            >
              <Plus className="h-4 w-4" />
              New flag
            </Button>
            {!loading && environments.length === 0 && (
              <p className="text-xs text-muted-foreground">
                <Link to="/org/$slug/environments" params={{ slug: org.slug }} className="underline underline-offset-2">
                  Create an environment
                </Link>{' '}
                first
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="surface-card overflow-hidden">
          <div className="divide-y divide-border">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4 sm:px-6">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full" />
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !error && flagsList.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Flag className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h2 className="text-base font-medium text-foreground mb-1">No flags yet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Feature flags let you ship code dark and roll out features gradually.
          </p>
          {isAdmin && environments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              <Link to="/org/$slug/environments" params={{ slug: org.slug }} className="underline underline-offset-2">
                Create an environment
              </Link>{' '}
              before creating flags.
            </p>
          )}
          {isAdmin && environments.length > 0 && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-4 w-4" />
              Create your first flag
            </Button>
          )}
        </div>
      )}

      {!loading && !error && flagsList.length > 0 && (
        <div className="surface-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-3 pl-5 pr-4 text-left text-[0.75rem] font-medium uppercase tracking-wide text-muted-foreground sm:pl-6">
                  Flag
                </th>
                {environments.map((env) => (
                  <th
                    key={env.id}
                    className="px-4 py-3 text-center text-[0.75rem] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {env.name}
                  </th>
                ))}
                <th className="py-3 pr-4 sm:pr-5" />
              </tr>
            </thead>
            <tbody>
              {flagsList.map((flag) => (
                <FlagTableRow
                  key={flag.id}
                  flag={flag}
                  environments={environments}
                  orgSlug={org.slug}
                  isAdmin={isAdmin}
                  onToggle={handleToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && flagsList.length > 0 && environments.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          Create an{' '}
          <Link to="/org/$slug/environments" params={{ slug: org.slug }} className="underline underline-offset-2">
            environment
          </Link>{' '}
          to start toggling flags.
        </p>
      )}

      <CreateFlagDialog
        orgSlug={org.slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </div>
  )
}
