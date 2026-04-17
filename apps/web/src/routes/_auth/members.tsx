import { useState, useMemo } from 'react'
import { Search, ChevronDown, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { authClient } from '@/lib/auth-client'
import { useOrg } from '@/lib/org-context'
import { api, type MemberRow as Member } from '@/lib/api-client'

// ── Role Picker ───────────────────────────────────────────────────────────────

function RolePicker({ member, orgSlug }: { member: Member; orgSlug: string }) {
  const [changing, setChanging] = useState(false)
  const queryClient = useQueryClient()

  async function handleChange(newRole: string) {
    if (newRole === member.role) return
    setChanging(true)
    try {
      await api.members.patch(orgSlug, member.id, newRole)
      queryClient.setQueryData(
        ['members', orgSlug],
        (old: { members: Member[] } | undefined) =>
          old
            ? { members: old.members.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)) }
            : old,
      )
      toast.success(`${member.name} is now a${newRole === 'admin' ? 'n' : ''} ${newRole}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    } finally {
      setChanging(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={changing}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'gap-1.5 capitalize font-normal',
        )}
      >
        {member.role}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleChange('admin')}>Admin</DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleChange('viewer')}>Viewer</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function MembersPage() {
  const { org, role } = useOrg()
  const isAdmin = role === 'admin'
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id
  const isSuperAdmin = (session?.user as Record<string, unknown> | undefined)?.isSuperAdmin === true

  const [suspendTarget, setSuspendTarget] = useState<Member | null>(null)
  const [suspending, setSuspending] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

  const { data: activeData, isLoading, error } = useQuery({
    queryKey: ['members', org.slug],
    queryFn: () => api.members.list(org.slug),
    enabled: isAdmin,
  })

  const { data: removedData } = useQuery({
    queryKey: ['members-removed', org.slug],
    queryFn: () => api.members.listRemoved(org.slug),
    enabled: isAdmin,
  })

  const membersList = activeData?.members ?? []
  const removedMembers = removedData?.members ?? []

  const filteredMembers = useMemo(() => {
    return membersList.filter((member) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        if (!member.name.toLowerCase().includes(q) && !member.email.toLowerCase().includes(q)) {
          return false
        }
      }
      if (roleFilter !== 'all' && member.role !== roleFilter) return false
      return true
    })
  }, [membersList, searchQuery, roleFilter])

  async function handleSuspend() {
    if (!suspendTarget) return
    setSuspending(true)
    try {
      await api.members.delete(org.slug, suspendTarget.id)
      queryClient.invalidateQueries({ queryKey: ['members', org.slug] })
      queryClient.invalidateQueries({ queryKey: ['members-removed', org.slug] })
      toast.success(`${suspendTarget.name} suspended`)
      setSuspendTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to suspend member')
    } finally {
      setSuspending(false)
    }
  }

  async function handleRestore(member: Member) {
    setRestoringId(member.id)
    try {
      await api.members.restore(org.slug, member.id)
      queryClient.invalidateQueries({ queryKey: ['members', org.slug] })
      queryClient.invalidateQueries({ queryKey: ['members-removed', org.slug] })
      toast.success(`${member.name} restored`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore member')
    } finally {
      setRestoringId(null)
    }
  }

  const columns = useMemo<ColumnDef<Member>[]>(
    () => [
      {
        id: 'member',
        header: 'Member',
        size: 600,
        cell: ({ row }) => {
          const member = row.original
          const isSelf = member.id === currentUserId
          return (
            <div className="flex min-w-0 items-center gap-3 py-0.5">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium leading-none">{member.name}</p>
                  {isSelf && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[0.6875rem]">
                      You
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{member.email}</p>
              </div>
            </div>
          )
        },
      },
      {
        id: 'role',
        header: 'Role',
        size: 130,
        cell: ({ row }) => {
          const member = row.original
          const isSelf = member.id === currentUserId
          if (isSuperAdmin && !isSelf) {
            return <RolePicker member={member} orgSlug={org.slug} />
          }
          return (
            <Badge variant="secondary" className="capitalize">
              {member.role}
            </Badge>
          )
        },
      },
      {
        id: 'joined',
        header: 'Joined',
        size: 130,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {DATE_FMT.format(new Date(row.original.createdAt))}
          </span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        size: 48,
        cell: ({ row }) => {
          const member = row.original
          const isSelf = member.id === currentUserId
          if (!isSuperAdmin || isSelf) {
            return (
              <span className="inline-flex h-8 w-8 items-center justify-center text-xs text-muted-foreground">
                —
              </span>
            )
          }
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
                  <DropdownMenuItem variant="destructive" onClick={() => setSuspendTarget(member)}>
                    Suspend
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [org.slug, isSuperAdmin, currentUserId],
  )

  const table = useReactTable({
    data: filteredMembers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  const roleFilterLabel = roleFilter === 'all' ? 'All' : roleFilter === 'admin' ? 'Admin' : 'Viewer'

  return (
    <div className="page-container page-container-wide page-enter">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Members</h1>
        </div>
      </div>

      {!isAdmin && !isLoading && (
        <div
          className="mb-8 rounded-lg border border-border bg-muted/35 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          Only admins can manage members.
        </div>
      )}

      {error && (
        <div
          className="mb-8 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error instanceof Error ? error.message : 'Failed to load members'}
        </div>
      )}

      {!isLoading && !error && isAdmin && membersList.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search members..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 text-sm"
            />
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'default' }),
                  'gap-1.5 font-normal',
                )}
              >
                <span className="text-muted-foreground">Role:</span>
                <span>{roleFilterLabel}</span>
                <ChevronDown className="ml-0.5 h-3.5 w-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-32">
                <DropdownMenuRadioGroup value={roleFilter} onValueChange={setRoleFilter}>
                  <DropdownMenuRadioItem value="all" closeOnClick>All</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="admin" closeOnClick>Admin</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="viewer" closeOnClick>Viewer</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {!isLoading && !error && isAdmin && membersList.length === 0 && (
        <div className="surface-card flex flex-col items-center justify-center px-6 py-16 text-center shadow-surface">
          <p className="mb-1 text-base font-medium text-foreground">No members yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            People who join this organization will appear here. Promotion and removal controls are
            available to admins.
          </p>
        </div>
      )}

      {!isLoading && !error && membersList.length > 0 && (
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
                      No members match your search.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between py-4">
            <p className="text-xs text-muted-foreground">
              {(() => {
                if (filteredMembers.length === 0) return `0 of ${membersList.length} members`
                const { pageIndex, pageSize } = table.getState().pagination
                const start = pageIndex * pageSize + 1
                const end = Math.min((pageIndex + 1) * pageSize, filteredMembers.length)
                return `${start}–${end} of ${membersList.length} members`
              })()}
            </p>
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

      {!isLoading && !error && isAdmin && removedMembers.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Suspended members</h2>
          <div className="rounded-md border">
            <Table>
              <TableBody>
                {removedMembers.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-sm font-medium leading-none text-muted-foreground">
                            {member.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestore(member)}
                        disabled={restoringId === member.id}
                      >
                        {restoringId === member.id ? 'Restoring…' : 'Restore'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!suspendTarget}
        onOpenChange={(open) => {
          if (!open && !suspending) setSuspendTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend member?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{suspendTarget?.name}</strong> ({suspendTarget?.email}) will lose access
              immediately. You can restore them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={suspending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSuspend} disabled={suspending}>
              {suspending ? 'Suspending…' : 'Suspend member'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
