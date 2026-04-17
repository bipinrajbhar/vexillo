import { useState, useMemo, useCallback, type FormEvent } from 'react'
import { Plus, MoreHorizontal, X, Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
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
  const [slug, setSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function slugify(s: string) {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  }

  function handleNameChange(value: string) {
    setName(value)
    setSlug(slugify(value))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const result = await api.environments.create(orgSlug, name.trim())
      onCreated(result.environment, result.apiKey)
      onOpenChange(false)
      setName('')
      setSlug('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create environment')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenChange(value: boolean) {
    if (!submitting) {
      onOpenChange(value)
      if (!value) { setName(''); setSlug('') }
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
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Production"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-slug">Slug</Label>
            <Input
              id="env-slug"
              value={slug}
              readOnly
              className="cursor-default bg-muted font-mono text-sm text-muted-foreground"
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
              disabled={submitting || !name.trim()}
              className="shadow-surface-xs"
            >
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
          <DialogDescription>Copy this key now — it will not be shown again.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all">
            {apiKey}
          </code>
          <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
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
}: {
  orgSlug: string
  env: EnvRow
  onUpdated: (id: string, origins: string[]) => void
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
    <div className="space-y-3">
      {origins.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          None — all cross-origin requests blocked
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {origins.map((origin) => (
            <Badge key={origin} variant="secondary" className="gap-1 font-mono text-[0.7rem]">
              {origin}
              <button
                onClick={() => handleRemove(origin)}
                disabled={saving}
                className="ml-0.5 rounded hover:text-destructive focus-visible:outline-none"
                aria-label={`Remove ${origin}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
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
          className="h-7 shrink-0 px-2 text-xs"
        >
          Add
        </Button>
      </div>
    </div>
  )
}

// ── Manage Origins Dialog ─────────────────────────────────────────────────────

function ManageOriginsDialog({
  orgSlug,
  env,
  open,
  onOpenChange,
  onUpdated,
}: {
  orgSlug: string
  env: EnvRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (id: string, origins: string[]) => void
}) {
  if (!env) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Allowed origins</DialogTitle>
          <DialogDescription>
            Control which origins can use the <strong>{env.name}</strong> SDK key.
          </DialogDescription>
        </DialogHeader>
        <AllowedOriginsEditor orgSlug={orgSlug} env={env} onUpdated={onUpdated} />
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function EnvironmentsPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'
  const queryClient = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [pendingApiKey, setPendingApiKey] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EnvRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [originsTarget, setOriginsTarget] = useState<EnvRow | null>(null)
  const [rotatingId, setRotatingId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['environments', org.slug],
    queryFn: () => api.environments.list(org.slug).then((r) => r.environments),
  })

  const envs = data ?? []

  function handleCreated(env: EnvRow, apiKey: string) {
    queryClient.invalidateQueries({ queryKey: ['environments', org.slug] })
    setPendingApiKey(apiKey)
    toast.success(`Environment "${env.name}" created`)
  }

  const handleRotate = useCallback(async (env: EnvRow) => {
    setRotatingId(env.id)
    try {
      const { apiKey } = await api.environments.rotateKey(org.slug, env.id)
      setPendingApiKey(apiKey)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate key')
    } finally {
      setRotatingId(null)
    }
  }, [org.slug])

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.environments.delete(org.slug, deleteTarget.id)
      queryClient.invalidateQueries({ queryKey: ['environments', org.slug] })
      toast.success(`Environment "${deleteTarget.name}" deleted`)
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete environment')
    } finally {
      setDeleting(false)
    }
  }

  function handleOriginsUpdated(id: string, origins: string[]) {
    queryClient.setQueryData(
      ['environments', org.slug],
      (old: EnvRow[] | undefined) =>
        old ? old.map((e) => (e.id === id ? { ...e, allowedOrigins: origins } : e)) : old,
    )
  }

  const columns = useMemo<ColumnDef<EnvRow>[]>(
    () => [
      {
        id: 'environment',
        header: 'Environment',
        size: 500,
        cell: ({ row }) => {
          const env = row.original
          return (
            <div className="space-y-1 py-0.5">
              <p className="text-sm font-medium leading-none">{env.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{env.slug}</p>
            </div>
          )
        },
      },
      {
        id: 'apiKey',
        header: 'API Key',
        size: 260,
        cell: ({ row }) => {
          const { keyHint } = row.original
          if (!keyHint) {
            return <span className="text-xs italic text-muted-foreground">No key</span>
          }
          return <code className="font-mono text-xs text-foreground">{keyHint}</code>
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        size: 48,
        cell: ({ row }) => {
          const env = row.original
          if (!isAdmin) return null
          const isRotating = rotatingId === env.id
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleRotate(env)} disabled={isRotating}>
                    Rotate key
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setOriginsTarget(env)}>
                    Manage origins
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(env)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [isAdmin, rotatingId, handleRotate],
  )

  const table = useReactTable({
    data: envs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Environments</h1>
        </div>
        {isAdmin && (
          <Button
            onClick={() => setCreateOpen(true)}
            size="default"
            className="shrink-0 gap-2 shadow-surface-xs"
          >
            <Plus className="h-4 w-4" />
            New environment
          </Button>
        )}
      </div>

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error instanceof Error ? error.message : 'Failed to load environments'}
        </div>
      )}

      {!isLoading && !error && envs.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">No environments yet</p>
          <p className="mb-8 max-w-sm text-sm text-muted-foreground">
            Environments let you manage separate flag states for production, staging, and
            development.
          </p>
          {isAdmin && (
            <Button onClick={() => setCreateOpen(true)} className="gap-2 shadow-surface-xs">
              <Plus className="h-4 w-4" />
              Create your first environment
            </Button>
          )}
        </div>
      )}

      {!isLoading && !error && envs.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} style={{ width: header.getSize() }}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
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

      <ManageOriginsDialog
        orgSlug={org.slug}
        env={originsTarget}
        open={!!originsTarget}
        onOpenChange={(open) => { if (!open) setOriginsTarget(null) }}
        onUpdated={handleOriginsUpdated}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting <strong>{deleteTarget?.name}</strong> will remove all its flag states and API
              keys. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete environment'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
