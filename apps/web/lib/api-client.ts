// ── Types ─────────────────────────────────────────────────────────────────────

export type FlagRow = {
  id: string
  name: string
  key: string
  description: string
  createdAt: string
  createdByName: string | null
  states: Record<string, boolean>
}

export type EnvRef = { id: string; name: string; slug: string }

export type EnvRow = {
  id: string
  name: string
  slug: string
  allowedOrigins: string[]
  createdAt: string
  keyHint: string | null
}

export type MemberRow = {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (res.status === 204) return undefined as T
  const body = await res.json()
  if (!res.ok) throw new ApiError(res.status, body.error ?? `API error ${res.status}`)
  return body as T
}

function json(body: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// ── API client ────────────────────────────────────────────────────────────────

export const api = {
  orgs: {
    list: () =>
      call<{ orgs: { id: string; name: string; slug: string }[] }>('/api/dashboard/me/orgs'),
  },

  flags: {
    list: (orgSlug: string) =>
      call<{ flags: FlagRow[]; environments: EnvRef[] }>(`/api/dashboard/${orgSlug}/flags`),

    create: (orgSlug: string, body: { name: string; key: string; description: string }) =>
      call<{ flag: FlagRow }>(`/api/dashboard/${orgSlug}/flags`, {
        method: 'POST',
        ...json(body),
      }),

    patch: (orgSlug: string, key: string, body: { name?: string; description?: string }) =>
      call<{ flag: FlagRow }>(
        `/api/dashboard/${orgSlug}/flags/${encodeURIComponent(key)}`,
        { method: 'PATCH', ...json(body) },
      ),

    delete: (orgSlug: string, key: string) =>
      call<void>(`/api/dashboard/${orgSlug}/flags/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),

    toggle: (orgSlug: string, key: string, environmentId: string) =>
      call<{ enabled: boolean }>(
        `/api/dashboard/${orgSlug}/flags/${encodeURIComponent(key)}/toggle`,
        { method: 'POST', ...json({ environmentId }) },
      ),
  },

  environments: {
    list: (orgSlug: string) =>
      call<{ environments: EnvRow[] }>(`/api/dashboard/${orgSlug}/environments`),

    create: (orgSlug: string, name: string) =>
      call<{ environment: EnvRow; apiKey: string }>(`/api/dashboard/${orgSlug}/environments`, {
        method: 'POST',
        ...json({ name }),
      }),

    patch: (orgSlug: string, id: string, allowedOrigins: string[]) =>
      call<{ environment: Pick<EnvRow, 'id' | 'allowedOrigins'> }>(
        `/api/dashboard/${orgSlug}/environments/${encodeURIComponent(id)}`,
        { method: 'PATCH', ...json({ allowedOrigins }) },
      ),

    delete: (orgSlug: string, id: string) =>
      call<void>(`/api/dashboard/${orgSlug}/environments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    rotateKey: (orgSlug: string, id: string) =>
      call<{ apiKey: string }>(
        `/api/dashboard/${orgSlug}/environments/${encodeURIComponent(id)}/rotate-key`,
        { method: 'POST' },
      ),
  },

  members: {
    list: (orgSlug: string) =>
      call<{ members: MemberRow[] }>(`/api/dashboard/${orgSlug}/members`),

    patch: (orgSlug: string, userId: string, role: string) =>
      call<{ member: { userId: string; role: string } }>(
        `/api/dashboard/${orgSlug}/members/${encodeURIComponent(userId)}`,
        { method: 'PATCH', ...json({ role }) },
      ),

    delete: (orgSlug: string, userId: string) =>
      call<void>(`/api/dashboard/${orgSlug}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }),
  },
}
