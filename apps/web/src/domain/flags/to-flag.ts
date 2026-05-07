import type { EnvRef, FlagRow } from '@/lib/api-client'
import type { Environment, Flag } from './types'

export function toEnvironment(ref: EnvRef): Environment {
  return Object.freeze({ id: ref.id, name: ref.name, slug: ref.slug })
}

export function toFlag(row: FlagRow): Flag {
  return Object.freeze({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: new Date(row.createdAt),
    createdByName: row.createdByName,
    isOnIn: (env: Environment) => !!row.states[env.slug],
    countriesIn: (env: Environment) => row.countryRules[env.slug] ?? [],
    isUnrestrictedIn: (env: Environment) =>
      (row.countryRules[env.slug] ?? []).length === 0,
  })
}
