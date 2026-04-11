import { Outlet } from '@tanstack/react-router'
import { ThemeProvider } from '@/components/theme-provider'

export function RootLayout() {
  return (
    <ThemeProvider>
      <Outlet />
    </ThemeProvider>
  )
}
