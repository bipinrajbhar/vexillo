import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModeToggle } from '@/components/mode-toggle'
import { VexilloMark } from '@/icons/vexillo'

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
    <div className="relative flex min-h-dvh flex-col bg-background">
      <div className="absolute end-4 top-4 z-10 sm:end-6 sm:top-6">
        <ModeToggle />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-5 py-16 sm:px-8">
        <div className="flex w-full max-w-[420px] flex-col items-center">
          {/* Logo */}
          <VexilloMark className="page-enter mb-5 h-10 w-auto" />

          {/* Heading */}
          <h1 className="page-enter page-enter-delay-1 mb-6 font-heading text-2xl font-semibold tracking-[-0.02em] text-foreground">
            Find your workspace
          </h1>

          {/* Form */}
          <form onSubmit={handleSubmit} className="page-enter page-enter-delay-2 w-full space-y-4">
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
            <Button type="submit" className="h-10 w-full" disabled={!slug.trim()}>
              Continue
            </Button>
          </form>
        </div>
      </div>

      <footer className="pb-6 text-center">
        <p className="text-[0.6875rem] text-muted-foreground/40">
          &copy; {new Date().getFullYear()} Vexillo
        </p>
      </footer>
    </div>
  )
}
