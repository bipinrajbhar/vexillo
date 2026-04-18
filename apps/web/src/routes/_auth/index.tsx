import { useState, useEffect, useRef, useMemo, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Plus, Search, ChevronDown, MoreHorizontal, Check, X } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
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

// ── Edit Flag Dialog ─────────────────────────────────────────────────────────

function EditFlagDialog({
  flag,
  orgSlug,
  open,
  onOpenChange,
  onSuccess,
}: {
  flag: FlagRow | null
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [name, setName] = useState(flag?.name ?? '')
  const [description, setDescription] = useState(flag?.description ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (flag) {
      setName(flag.name)
      setDescription(flag.description)
    }
  }, [flag])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!flag || !name.trim()) return
    setSaving(true)
    try {
      await api.flags.patch(orgSlug, flag.key, {
        name: name.trim(),
        description: description.trim(),
      })
      onSuccess()
      onOpenChange(false)
      toast.success('Flag updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update flag')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit flag</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-flag-name">Name</Label>
            <Input
              id="edit-flag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-flag-description">
              Description
            </Label>
            <Textarea
              id="edit-flag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this flag control?"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Country data ─────────────────────────────────────────────────────────────

const COUNTRIES = [
  { code: 'US', name: 'United States', region: 'Americas' },
  { code: 'CA', name: 'Canada', region: 'Americas' },
  { code: 'MX', name: 'Mexico', region: 'Americas' },
  { code: 'BR', name: 'Brazil', region: 'Americas' },
  { code: 'AR', name: 'Argentina', region: 'Americas' },
  { code: 'CL', name: 'Chile', region: 'Americas' },
  { code: 'CO', name: 'Colombia', region: 'Americas' },
  { code: 'PE', name: 'Peru', region: 'Americas' },
  { code: 'UY', name: 'Uruguay', region: 'Americas' },
  { code: 'GB', name: 'United Kingdom', region: 'Europe' },
  { code: 'IE', name: 'Ireland', region: 'Europe' },
  { code: 'FR', name: 'France', region: 'Europe' },
  { code: 'DE', name: 'Germany', region: 'Europe' },
  { code: 'ES', name: 'Spain', region: 'Europe' },
  { code: 'PT', name: 'Portugal', region: 'Europe' },
  { code: 'IT', name: 'Italy', region: 'Europe' },
  { code: 'NL', name: 'Netherlands', region: 'Europe' },
  { code: 'BE', name: 'Belgium', region: 'Europe' },
  { code: 'CH', name: 'Switzerland', region: 'Europe' },
  { code: 'AT', name: 'Austria', region: 'Europe' },
  { code: 'SE', name: 'Sweden', region: 'Europe' },
  { code: 'NO', name: 'Norway', region: 'Europe' },
  { code: 'DK', name: 'Denmark', region: 'Europe' },
  { code: 'FI', name: 'Finland', region: 'Europe' },
  { code: 'IS', name: 'Iceland', region: 'Europe' },
  { code: 'PL', name: 'Poland', region: 'Europe' },
  { code: 'CZ', name: 'Czech Republic', region: 'Europe' },
  { code: 'GR', name: 'Greece', region: 'Europe' },
  { code: 'RO', name: 'Romania', region: 'Europe' },
  { code: 'HU', name: 'Hungary', region: 'Europe' },
  { code: 'JP', name: 'Japan', region: 'Asia Pacific' },
  { code: 'KR', name: 'South Korea', region: 'Asia Pacific' },
  { code: 'CN', name: 'China', region: 'Asia Pacific' },
  { code: 'TW', name: 'Taiwan', region: 'Asia Pacific' },
  { code: 'HK', name: 'Hong Kong', region: 'Asia Pacific' },
  { code: 'SG', name: 'Singapore', region: 'Asia Pacific' },
  { code: 'MY', name: 'Malaysia', region: 'Asia Pacific' },
  { code: 'TH', name: 'Thailand', region: 'Asia Pacific' },
  { code: 'VN', name: 'Vietnam', region: 'Asia Pacific' },
  { code: 'PH', name: 'Philippines', region: 'Asia Pacific' },
  { code: 'ID', name: 'Indonesia', region: 'Asia Pacific' },
  { code: 'IN', name: 'India', region: 'Asia Pacific' },
  { code: 'AU', name: 'Australia', region: 'Asia Pacific' },
  { code: 'NZ', name: 'New Zealand', region: 'Asia Pacific' },
  { code: 'AE', name: 'United Arab Emirates', region: 'Middle East & Africa' },
  { code: 'SA', name: 'Saudi Arabia', region: 'Middle East & Africa' },
  { code: 'IL', name: 'Israel', region: 'Middle East & Africa' },
  { code: 'TR', name: 'Turkey', region: 'Middle East & Africa' },
  { code: 'EG', name: 'Egypt', region: 'Middle East & Africa' },
  { code: 'ZA', name: 'South Africa', region: 'Middle East & Africa' },
  { code: 'NG', name: 'Nigeria', region: 'Middle East & Africa' },
  { code: 'KE', name: 'Kenya', region: 'Middle East & Africa' },
  { code: 'MA', name: 'Morocco', region: 'Middle East & Africa' },
]

const COUNTRY_REGIONS = ['Americas', 'Europe', 'Asia Pacific', 'Middle East & Africa'] as const

// ── CountryPicker ─────────────────────────────────────────────────────────────

function CountryPicker({
  selected,
  allCountries,
  onChange,
  disabled,
}: {
  selected: string[]
  allCountries: boolean
  onChange: (value: { countries: string[]; allCountries: boolean }) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!open) { setSearch(''); return }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setRect(r)
    setTimeout(() => searchRef.current?.focus(), 0)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        dropdownRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return COUNTRIES
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    )
  }, [search])

  const grouped = useMemo(() => {
    const map = new Map<string, typeof COUNTRIES>()
    for (const region of COUNTRY_REGIONS) map.set(region, [])
    for (const c of filtered) {
      const bucket = map.get(c.region)
      if (bucket) bucket.push(c)
    }
    return map
  }, [filtered])

  function toggle(code: string) {
    if (allCountries) {
      onChange({ countries: COUNTRIES.map((c) => c.code).filter((c) => c !== code), allCountries: false })
    } else {
      const next = selected.includes(code)
        ? selected.filter((c) => c !== code)
        : [...selected, code]
      const isAll = next.length === COUNTRIES.length
      onChange({ countries: isAll ? [] : next, allCountries: isAll })
    }
  }

  function selectAll() {
    onChange({ countries: [], allCountries: true })
  }

  function clear() {
    onChange({ countries: [], allCountries: false })
  }

  const label = allCountries
    ? 'All countries'
    : selected.length === 0
      ? 'No countries'
      : selected.length <= 3
        ? selected.join(', ')
        : `${selected.slice(0, 2).join(', ')} +${selected.length - 2}`

  const dropdown = open && rect
    ? createPortal(
        <div
          ref={dropdownRef}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            right: window.innerWidth - rect.right,
            zIndex: 9999,
            width: 280,
          }}
          className="rounded-lg border border-border bg-popover shadow-md overflow-hidden flex flex-col"
        >
          {/* Search */}
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search countries…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Chips row */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border">
            <button
              type="button"
              onClick={selectAll}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium transition-colors',
                allCountries
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted-foreground hover:bg-muted'
              )}
            >
              {allCountries && <Check className="h-2.5 w-2.5" />}
              All countries
            </button>
            <button
              type="button"
              onClick={clear}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              <X className="h-2.5 w-2.5" />
              Clear
            </button>
            <span className="ml-auto text-[0.65rem] text-muted-foreground tabular-nums">
              {allCountries ? COUNTRIES.length : selected.length} / {COUNTRIES.length}
            </span>
          </div>

          {/* List */}
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No results</p>
            ) : (
              Array.from(grouped.entries()).map(([region, countries]) => {
                if (countries.length === 0) return null
                return (
                  <div key={region}>
                    <p className="px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground/60">
                      {region}
                    </p>
                    {countries.map(({ code, name }) => {
                      const checked = allCountries || selected.includes(code)
                      return (
                        <button
                          key={code}
                          type="button"
                          onClick={() => toggle(code)}
                          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted transition-colors"
                        >
                          <span
                            className={cn(
                              'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                              checked ? 'bg-primary border-primary' : 'border-input'
                            )}
                          >
                            {checked && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                          </span>
                          <span className="font-mono w-7 shrink-0 text-muted-foreground">{code}</span>
                          <span>{name}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50 max-w-[160px]',
          allCountries && 'text-muted-foreground'
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-40 shrink-0" />
      </button>
      {dropdown}
    </>
  )
}

// ── Targeting Dialog ──────────────────────────────────────────────────────────

type EnvDraft = { countries: string[]; allCountries: boolean; enabled: boolean }

function buildInitialDraft(flag: FlagRow | null, environments: Env[]): Record<string, EnvDraft> {
  const draft: Record<string, EnvDraft> = {}
  for (const env of environments) {
    const codes = flag?.countryRules[env.slug] ?? []
    draft[env.id] = {
      countries: codes,
      allCountries: codes.length === 0,
      enabled: !!(flag?.states[env.slug]),
    }
  }
  return draft
}

function TargetingDialog({
  flag,
  orgSlug,
  environments,
  isAdmin,
  open,
  onOpenChange,
  onChanged,
}: {
  flag: FlagRow | null
  orgSlug: string
  environments: Env[]
  isAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [savedDraft, setSavedDraft] = useState<Record<string, EnvDraft>>({})
  const [draft, setDraft] = useState<Record<string, EnvDraft>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !flag) return
    const initial = buildInitialDraft(flag, environments)
    setSavedDraft(initial)
    setDraft(initial)
  }, [flag, environments, open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft])

  const isDirtyGlobal = useMemo(() => {
    return environments.some((env) => {
      const d = draft[env.id]
      const s = savedDraft[env.id]
      if (!d || !s) return false
      return (
        d.allCountries !== s.allCountries ||
        [...d.countries].sort().join(',') !== [...s.countries].sort().join(',') ||
        d.enabled !== s.enabled
      )
    })
  }, [draft, savedDraft, environments])

  function isEnvDirty(envId: string) {
    const d = draft[envId]
    const s = savedDraft[envId]
    if (!d || !s) return false
    return (
      d.allCountries !== s.allCountries ||
      [...d.countries].sort().join(',') !== [...s.countries].sort().join(',') ||
      d.enabled !== s.enabled
    )
  }

  function patchDraft(envId: string, patch: Partial<EnvDraft>) {
    setDraft((prev) => ({ ...prev, [envId]: { ...prev[envId], ...patch } }))
  }

  async function handleSave() {
    if (!flag || saving || !isDirtyGlobal) return
    setSaving(true)
    try {
      await Promise.all(
        environments.map(async (env) => {
          const d = draft[env.id]
          const s = savedDraft[env.id]
          if (!d || !s) return
          const countriesDirty =
            d.allCountries !== s.allCountries ||
            [...d.countries].sort().join(',') !== [...s.countries].sort().join(',')
          const enabledDirty = d.enabled !== s.enabled
          if (countriesDirty) {
            await api.flags.updateCountryRules(orgSlug, flag.key, env.id, d.allCountries ? [] : d.countries)
          }
          if (enabledDirty) {
            await api.flags.toggle(orgSlug, flag.key, env.id)
          }
        })
      )
      setSavedDraft(draft)
      onChanged()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraft(savedDraft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 pr-12">
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-medium uppercase tracking-widest text-muted-foreground">Configure</p>
            <DialogTitle className="truncate text-sm font-semibold tracking-tight">
              {flag?.name}
            </DialogTitle>
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
          {environments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No environments yet.</p>
          ) : (
            environments.map((env) => {
              const d = draft[env.id] ?? { countries: [], allCountries: true, enabled: false }
              const dirty = isEnvDirty(env.id)

              return (
                <div
                  key={env.id}
                  className="px-4 py-4 space-y-3"
                >
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {env.name}
                  </p>

                  {/* Rule 1 — Country targeting */}
                  <div className="flex items-center gap-3">
                    <div className="flex shrink-0 flex-col items-center self-stretch">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-[0.6rem] font-medium text-muted-foreground">
                        1
                      </span>
                      <div className="w-px flex-1 bg-border/60 my-0.5" />
                    </div>
                    <div className="flex flex-1 items-center justify-between gap-2">
                      <div>
                        <p className="text-sm leading-tight">Country targeting</p>
                        <p className="text-[0.7rem] text-muted-foreground mt-0.5">Allow traffic from specific countries</p>
                      </div>
                      {isAdmin ? (
                        <CountryPicker
                          selected={d.countries}
                          allCountries={d.allCountries}
                          onChange={(val) => patchDraft(env.id, val)}
                          disabled={saving}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {d.allCountries ? 'All countries' : d.countries.length === 0 ? 'None' : d.countries.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Rule 2 — Enable */}
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[0.6rem] font-medium text-muted-foreground">
                      2
                    </span>
                    <div className="flex flex-1 items-center justify-between">
                      <div>
                        <p className="text-sm leading-tight">Enable</p>
                        <p className="text-[0.7rem] text-muted-foreground mt-0.5">Roll out to matching users</p>
                      </div>
                      <Switch
                        checked={d.enabled}
                        onCheckedChange={(v) => isAdmin && patchDraft(env.id, { enabled: !!v })}
                        disabled={!isAdmin || saving}
                        aria-label={`Toggle ${flag?.name} in ${env.name}`}
                      />
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="-mx-0 flex items-center justify-between gap-2 rounded-b-xl border-t bg-muted/50 px-4 py-3">
          <span className="font-mono text-[0.6875rem] text-muted-foreground/60">{flag?.key}</span>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={saving || !isDirtyGlobal}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

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
  const [flagToEdit, setFlagToEdit] = useState<FlagRow | null>(null)
  const [flagToTarget, setFlagToTarget] = useState<FlagRow | null>(null)
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
              {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setFlagToEdit(flag)}>
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFlagToTarget(flag)}>
                    Configure
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setFlagToDelete(flag)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              )}
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
            disabled={!isLoading && environments.length === 0}
            title={!isLoading && environments.length === 0 ? 'Create an environment before adding flags' : undefined}
          >
            <Plus className="h-4 w-4" />
            New flag
          </Button>
        )}
      </div>

      {!isLoading && !error && flagsList.length > 0 && (
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
          {environments.length === 0 ? (
            <>
              <p className="mb-1 text-base font-medium text-foreground">No environments yet</p>
              <p className="mb-8 max-w-sm text-sm text-muted-foreground">
                Create an environment before adding flags.
              </p>
              {isAdmin && (
                <Link
                  to="/org/$slug/environments"
                  params={{ slug: org.slug }}
                  className={cn(buttonVariants({ variant: 'default' }), 'gap-2 shadow-surface-xs')}
                >
                  Go to Environments
                </Link>
              )}
            </>
          ) : (
            <>
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
            </>
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

          <div className="flex items-center justify-between py-4">
            <p className="text-xs text-muted-foreground">
              {(() => {
                if (filteredFlags.length === 0) return `0 of ${flagsList.length} flags`
                const { pageIndex, pageSize } = table.getState().pagination
                const start = pageIndex * pageSize + 1
                const end = Math.min((pageIndex + 1) * pageSize, filteredFlags.length)
                return `${start}–${end} of ${flagsList.length} flags`
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

      <CreateFlagDialog
        orgSlug={org.slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['flags', org.slug] })}
      />

      <TargetingDialog
        flag={flagToTarget}
        orgSlug={org.slug}
        environments={environments}
        isAdmin={isAdmin}
        open={!!flagToTarget}
        onOpenChange={(v) => { if (!v) setFlagToTarget(null) }}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['flags', org.slug] })}
      />

      <EditFlagDialog
        flag={flagToEdit}
        orgSlug={org.slug}
        open={!!flagToEdit}
        onOpenChange={(v) => { if (!v) setFlagToEdit(null) }}
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
