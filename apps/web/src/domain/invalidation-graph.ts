export type Domain = 'flags' | 'environments' | 'members' | 'members-removed'

export const invalidationGraph: Record<Domain, readonly Domain[]> = {
  flags: [],
  environments: ['flags'],
  members: ['members-removed'],
  'members-removed': ['members'],
}

export function queryKeyFor(domain: Domain, orgSlug: string): readonly unknown[] {
  return [domain, orgSlug]
}

export function invalidationsFor(
  domain: Domain,
  orgSlug: string,
): readonly (readonly unknown[])[] {
  return [
    queryKeyFor(domain, orgSlug),
    ...invalidationGraph[domain].map((d) => queryKeyFor(d, orgSlug)),
  ]
}
