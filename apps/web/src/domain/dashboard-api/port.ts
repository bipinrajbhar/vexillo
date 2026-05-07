import type { EnvRef, EnvRow, FlagRow, MemberRow } from '@/lib/api-client'

export interface DashboardApi {
  orgs: {
    list(): Promise<{ orgs: { id: string; name: string; slug: string }[] }>
  }
  flags: {
    list(orgSlug: string): Promise<{ flags: FlagRow[]; environments: EnvRef[] }>
    create(
      orgSlug: string,
      body: { name: string; key: string; description: string },
    ): Promise<{ flag: FlagRow }>
    patch(
      orgSlug: string,
      key: string,
      body: { name?: string; description?: string },
    ): Promise<{ flag: FlagRow }>
    delete(orgSlug: string, key: string): Promise<void>
    toggle(
      orgSlug: string,
      key: string,
      environmentId: string,
    ): Promise<{ enabled: boolean }>
    updateCountryRules(
      orgSlug: string,
      key: string,
      environmentId: string,
      countries: string[],
    ): Promise<{ countries: string[] }>
  }
  environments: {
    list(orgSlug: string): Promise<{ environments: EnvRow[] }>
    create(
      orgSlug: string,
      name: string,
    ): Promise<{ environment: EnvRow; apiKey: string }>
    patch(
      orgSlug: string,
      id: string,
      allowedOrigins: string[],
    ): Promise<{ environment: Pick<EnvRow, 'id' | 'allowedOrigins'> }>
    delete(orgSlug: string, id: string): Promise<void>
    rotateKey(orgSlug: string, id: string): Promise<{ apiKey: string }>
  }
  members: {
    list(orgSlug: string): Promise<{ members: MemberRow[] }>
    listRemoved(orgSlug: string): Promise<{ members: MemberRow[] }>
    patch(
      orgSlug: string,
      userId: string,
      role: string,
    ): Promise<{ member: { userId: string; role: string } }>
    delete(orgSlug: string, userId: string): Promise<void>
    restore(orgSlug: string, userId: string): Promise<void>
  }
}
