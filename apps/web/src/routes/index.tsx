import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Flag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModeToggle } from '@/components/mode-toggle'

export function WorkspacePage() {
  const [slug, setSlug] = useState('')
  const navigate = useNavigate()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = slug.trim().toLowerCase()
    if (!trimmed) return
    navigate({ to: '/org/$slug/flags', params: { slug: trimmed } })
  }

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden">
      {/* Subtle dot-grid background */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          backgroundImage:
            'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage:
            'radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 100%)',
          opacity: 0.6,
        }}
      />

      <div className="absolute end-4 top-4 z-10 sm:end-6 sm:top-6">
        <ModeToggle />
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center px-5 pb-24 pt-16 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="page-enter mb-8 flex flex-col items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card shadow-surface">
              <Flag className="h-5 w-5 text-foreground" strokeWidth={1.75} />
            </div>
            <header className="text-center">
              <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
                Find your workspace
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Enter your organisation slug to continue
              </p>
            </header>
          </div>

          <form onSubmit={handleSubmit} className="page-enter page-enter-delay-1 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="org-slug">Workspace slug</Label>
              <Input
                id="org-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="your-org-slug"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <Button
              type="submit"
              className="h-10 w-full"
              disabled={!slug.trim()}
            >
              Continue
            </Button>
          </form>

        </div>
      </div>

      <footer className="relative pb-6 text-center">
        <p className="text-[0.6875rem] text-muted-foreground/50">
          &copy; {new Date().getFullYear()} Vexillo
        </p>
      </footer>
    </div>
  )
}
