import * as React from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <TooltipProvider delay={300}>{children}</TooltipProvider>
      <Toaster position="top-center" richColors closeButton />
    </NextThemesProvider>
  )
}
