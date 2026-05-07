import { createContext, useContext, type ReactNode } from 'react'
import type { DashboardApi } from './port'

const DashboardApiCtx = createContext<DashboardApi | null>(null)

export function DashboardApiProvider({
  value,
  children,
}: {
  value: DashboardApi
  children: ReactNode
}) {
  return <DashboardApiCtx.Provider value={value}>{children}</DashboardApiCtx.Provider>
}

export function useDashboardApi(): DashboardApi {
  const ctx = useContext(DashboardApiCtx)
  if (!ctx) throw new Error('useDashboardApi must be called inside DashboardApiProvider')
  return ctx
}
