import { useCallback } from 'react'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { EnvRef, FlagRow } from '@/lib/api-client'
import { useDashboardApi } from '../dashboard-api/provider'
import { invalidationsFor, queryKeyFor } from '../invalidation-graph'
import { toEnvironment, toFlag } from './to-flag'
import type { Environment, Flag } from './types'

type FlagsPayload = { flags: FlagRow[]; environments: EnvRef[] }
type FlagsView = { flags: readonly Flag[]; environments: readonly Environment[] }

export interface UseFlagsResult {
  flags: readonly Flag[]
  environments: readonly Environment[]
  isLoading: boolean
  error: Error | null
  create: (input: { name: string; key: string; description: string }) => Promise<Flag>
  edit: (flag: Flag, patch: { name?: string; description?: string }) => Promise<void>
  remove: (flag: Flag) => Promise<void>
  toggle: (flag: Flag, env: Environment) => Promise<void>
  setCountries: (flag: Flag, env: Environment, countries: string[]) => Promise<void>
}

export function useFlags(orgSlug: string): UseFlagsResult {
  const api = useDashboardApi()
  const qc = useQueryClient()
  const key = queryKeyFor('flags', orgSlug) as QueryKey

  const query = useQuery<FlagsPayload, Error, FlagsView>({
    queryKey: key,
    queryFn: () => api.flags.list(orgSlug),
    select: (data) => ({
      flags: data.flags.map(toFlag),
      environments: data.environments.map(toEnvironment),
    }),
  })

  const invalidate = useCallback(() => {
    for (const k of invalidationsFor('flags', orgSlug)) {
      qc.invalidateQueries({ queryKey: k as QueryKey })
    }
  }, [qc, orgSlug])

  const create = useCallback(
    async (input: { name: string; key: string; description: string }) => {
      try {
        const { flag } = await api.flags.create(orgSlug, input)
        invalidate()
        toast.success(`Flag "${flag.name}" created`)
        return toFlag(flag)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create flag')
        throw err
      }
    },
    [api, orgSlug, invalidate],
  )

  const edit = useCallback(
    async (flag: Flag, patch: { name?: string; description?: string }) => {
      try {
        await api.flags.patch(orgSlug, flag.key, patch)
        invalidate()
        toast.success('Flag updated')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update flag')
        throw err
      }
    },
    [api, orgSlug, invalidate],
  )

  const remove = useCallback(
    async (flag: Flag) => {
      try {
        await api.flags.delete(orgSlug, flag.key)
        invalidate()
        toast.success(`Flag "${flag.name}" deleted`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete flag')
        throw err
      }
    },
    [api, orgSlug, invalidate],
  )

  const toggle = useCallback(
    async (flag: Flag, env: Environment) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<FlagsPayload>(key)
      qc.setQueryData<FlagsPayload>(key, (data) =>
        data
          ? {
              ...data,
              flags: data.flags.map((f) =>
                f.id === flag.id
                  ? { ...f, states: { ...f.states, [env.slug]: !f.states[env.slug] } }
                  : f,
              ),
            }
          : data,
      )
      try {
        await api.flags.toggle(orgSlug, flag.key, env.id)
      } catch (err) {
        if (prev) qc.setQueryData(key, prev)
        toast.error(err instanceof Error ? err.message : 'Failed to update rollout')
        throw err
      } finally {
        invalidate()
      }
    },
    [api, orgSlug, qc, key, invalidate],
  )

  const setCountries = useCallback(
    async (flag: Flag, env: Environment, countries: string[]) => {
      try {
        await api.flags.updateCountryRules(orgSlug, flag.key, env.id, countries)
        invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save')
        throw err
      }
    },
    [api, orgSlug, invalidate],
  )

  return {
    flags: query.data?.flags ?? [],
    environments: query.data?.environments ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    create,
    edit,
    remove,
    toggle,
    setCountries,
  }
}
