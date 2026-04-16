import { useState, useEffect, useMemo, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus, Search, ChevronDown, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useOrg } from '@/lib/org-context'
import { api, type FlagRow, type EnvRef as Env } from '@/lib/api-client'
import { cn } from '@/lib/utils'

// ── Create Flag Dialog ───────────────────────────────────────────────────────

function CreateFlagDialog({
  orgSlug,
  open,
  onOpenChange,
  onSuccess,
}: {
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
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
    setKey(slugify(value))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return

    setSubmitting(true)
    try {
      const { flag } = await api.flags.create(orgSlug, {
        name: name.trim(),
        key: key.trim() || slugify(name),
        description: description.trim(),
      })
      onSuccess()
      onOpenChange(false)
      setName('')
      setKey('')
      setDescription('')
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
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New flag</DialogTitle>
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
              readOnly
              className="font-mono text-sm bg-muted text-muted-foreground cursor-default"
            />
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
            <Button
              type="submit"
              disabled={submitting || !name.trim()}
              className="shadow-surface-xs"
            >
              {submitting ? 'Creating…' : 'Create flag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function FlagsPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'
  const queryClient = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [flagToDelete, setFlagToDelete] = useState<FlagRow | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [envFilter, setEnvFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['flags', org.slug],
    queryFn: () => api.flags.list(org.slug),
  })

  const deleteMutation = useMutation({
    mutationFn: (flag: FlagRow) => api.flags.delete(org.slug, flag.key),
    onSuccess: (_, flag) => {
      queryClient.invalidateQueries({ queryKey: ['flags', org.slug] })
      toast.success(`Flag "${flag.name}" deleted`)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete flag')
    },
  })

  const environments = data?.environments ?? []
  const flagsList = data?.flags ?? []

  useEffect(() => {
    if (envFilter === '' && environments.length) {
      setEnvFilter(environments[0].id)
    }
  }, [environments, envFilter])

  const selectedEnv = environments.find((e) => e.id === envFilter) ?? null

  const filteredFlags = useMemo(() => {
    return flagsList.filter((flag) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        if (!flag.name.toLowerCase().includes(q) && !flag.key.toLowerCase().includes(q)) {
          return false
        }
      }
      if (statusFilter !== 'all') {
        const isOn = selectedEnv ? !!flag.states[selectedEnv.slug] : null
        if (statusFilter === 'on' && isOn !== true) return false
        if (statusFilter === 'off' && isOn !== false) return false
      }
      return true
    })
  }, [flagsList, searchQuery, statusFilter, selectedEnv])

  const columns = useMemo<ColumnDef<FlagRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Flag',
        size: 600,
        cell: ({ row }) => {
          const flag = row.original
          return (
            <div className="space-y-1 py-0.5">
              <p className="font-medium text-sm leading-none">{flag.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{flag.key}</p>
              {flag.description && (
                <p className="text-xs text-muted-foreground max-w-sm">{flag.description}</p>
              )}
              <p className="text-xs text-muted-foreground pt-0.5">
                {flag.createdByName ?? 'Unknown'} · {DATE_FMT.format(new Date(flag.createdAt))}
              </p>
            </div>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        size: 100,
        cell: ({ row }) => {
          const isOn = selectedEnv ? !!row.original.states[selectedEnv.slug] : null
          return isOn === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Badge variant={isOn ? 'success' : 'secondary'}>{isOn ? 'On' : 'Off'}</Badge>
          )
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        size: 48,
        cell: ({ row }) => {
          const flag = row.original
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
                  <DropdownMenuItem>
                    <Link to="/org/$slug/flags/$key" params={{ slug: org.slug, key: flag.key }} className="w-full">
                      Edit
                    </Link>
                  </DropdownMenuItem>
                  {isAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setFlagToDelete(flag)}
                      >
                        Delete flag
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [org.slug, selectedEnv, isAdmin]
  )

  const table = useReactTable({
    data: filteredFlags,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  const envFilterLabel = selectedEnv?.name ?? '—'
  const statusFilterLabel = statusFilter === 'all' ? 'All' : statusFilter === 'on' ? 'On' : 'Off'

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Flags</h1>
        </div>
        {isAdmin && (
          <Button
            onClick={() => setCreateOpen(true)}
            size="default"
            className="shrink-0 gap-2 shadow-surface-xs"
          >
            <Plus className="h-4 w-4" />
            New flag
          </Button>
        )}
      </div>

      {!isLoading && !error && (
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search flags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 text-sm"
            />
          </div>

          <div className="ml-auto flex shrink-0 gap-2">
            {environments.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  className={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'gap-1.5 font-normal')}
                >
                  <span className="text-muted-foreground">Env:</span>
                  <span>{envFilterLabel}</span>
                  <ChevronDown className="ml-0.5 h-3.5 w-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-36">
                  <DropdownMenuRadioGroup value={envFilter} onValueChange={setEnvFilter}>
                    {environments.map((env) => (
                      <DropdownMenuRadioItem key={env.id} value={env.id} closeOnClick>
                        {env.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                className={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'gap-1.5 font-normal')}
              >
                <span className="text-muted-foreground">Status:</span>
                <span>{statusFilterLabel}</span>
                <ChevronDown className="ml-0.5 h-3.5 w-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-32">
                <DropdownMenuRadioGroup value={statusFilter} onValueChange={setStatusFilter}>
                  <DropdownMenuRadioItem value="all" closeOnClick>All</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="on" closeOnClick>On</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="off" closeOnClick>Off</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error instanceof Error ? error.message : 'Failed to load flags'}
        </div>
      )}

      {!isLoading && !error && flagsList.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">No flags yet</p>
          <p className="mb-8 max-w-sm text-sm text-muted-foreground">
            Toggle features on or off per environment.
          </p>
          {isAdmin && (
            <Button onClick={() => setCreateOpen(true)} className="gap-2 shadow-surface-xs">
              <Plus className="h-4 w-4" />
              New flag
            </Button>
          )}
        </div>
      )}

      {!isLoading && !error && flagsList.length > 0 && (
        <>
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
                {table.getRowModel().rows.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-24 text-center">
                      No flags match your filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-end py-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <CreateFlagDialog
        orgSlug={org.slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['flags', org.slug] })}
      />

      <AlertDialog open={!!flagToDelete} onOpenChange={(open) => { if (!open) setFlagToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete flag</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{flagToDelete?.name}</strong> will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (flagToDelete) {
                  setFlagToDelete(null)
                  deleteMutation.mutate(flagToDelete)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
