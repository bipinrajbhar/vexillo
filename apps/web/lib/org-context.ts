import { createContext, useContext } from 'react'

export interface OrgInfo {
  id: string
  name: string
  slug: string
}

export interface OrgContextValue {
  org: OrgInfo
  role: 'admin' | 'viewer'
}

export const OrgCtx = createContext<OrgContextValue | null>(null)

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgCtx)
  if (!ctx) throw new Error('useOrg must be called inside OrgLayout')
  return ctx
}
