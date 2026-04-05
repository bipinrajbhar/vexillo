'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

interface Environment {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  createdAt: string;
  keyHint: string | null;
}

interface RevealedKey {
  environmentId: string;
  apiKey: string;
}

export default function EnvironmentsPage() {
  const { data: sessionData } = authClient.useSession();
  const isAdmin = (sessionData?.user as { role?: string } | undefined)?.role === 'admin';

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [rotating, setRotating] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
  const [newOrigin, setNewOrigin] = useState<Record<string, string>>({});
  const [originBusy, setOriginBusy] = useState<string | null>(null);

  const fetchEnvironments = useCallback(async () => {
    const res = await fetch('/api/environments');
    const data = await res.json();
    setEnvironments(data.environments ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchEnvironments();
  }, [fetchEnvironments]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const res = await fetch('/api/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error ?? 'Failed to create environment');
        return;
      }
      setNewName('');
      setShowForm(false);
      setRevealedKey({ environmentId: data.environment.id, apiKey: data.apiKey });
      await fetchEnvironments();
    } finally {
      setCreating(false);
    }
  }

  async function handleRotate(envId: string) {
    setRotating(envId);
    try {
      const res = await fetch(`/api/environments/${envId}/rotate-key`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setRevealedKey({ environmentId: envId, apiKey: data.apiKey });
        await fetchEnvironments();
      }
    } finally {
      setRotating(null);
    }
  }

  function dismissRevealedKey() {
    setRevealedKey(null);
  }

  async function patchOrigins(envId: string, origins: string[]) {
    setOriginBusy(envId);
    try {
      const res = await fetch(`/api/environments/${envId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: origins }),
      });
      if (res.ok) {
        setEnvironments((prev) =>
          prev.map((e) => (e.id === envId ? { ...e, allowedOrigins: origins } : e)),
        );
      }
    } finally {
      setOriginBusy(null);
    }
  }

  async function handleAddOrigin(e: React.FormEvent, envId: string) {
    e.preventDefault();
    const origin = newOrigin[envId]?.trim();
    if (!origin) return;
    const env = environments.find((e) => e.id === envId);
    if (!env || env.allowedOrigins.includes(origin)) return;
    await patchOrigins(envId, [...env.allowedOrigins, origin]);
    setNewOrigin((prev) => ({ ...prev, [envId]: '' }));
  }

  async function handleRemoveOrigin(envId: string, origin: string) {
    const env = environments.find((e) => e.id === envId);
    if (!env) return;
    await patchOrigins(envId, env.allowedOrigins.filter((o) => o !== origin));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Environments</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {environments.length} environment{environments.length !== 1 ? 's' : ''}
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => { setShowForm((v) => !v); setCreateError(''); }} variant={showForm ? 'outline' : 'default'}>
            {showForm ? 'Cancel' : 'New Environment'}
          </Button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="border rounded-lg p-6 space-y-4 bg-card mb-8">
          <h2 className="font-semibold">Create Environment</h2>
          {createError && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
              {createError}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="env-name">Name</Label>
            <Input
              id="env-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoFocus
              placeholder="QA"
            />
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create Environment'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setShowForm(false); setCreateError(''); }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {revealedKey && (
        <RevealedKeyBanner
          apiKey={revealedKey.apiKey}
          onDismiss={dismissRevealedKey}
        />
      )}

      {environments.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-base mb-1">No environments yet</p>
          <p className="text-sm">Create your first environment to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border divide-y">
          {environments.map((env) => (
            <div key={env.id} className="px-4 py-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{env.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{env.slug}</p>
                  {env.keyHint ? (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{env.keyHint}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">No API key</p>
                  )}
                </div>
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRotate(env.id)}
                    disabled={rotating === env.id}
                  >
                    {rotating === env.id ? 'Rotating…' : env.keyHint ? 'Rotate key' : 'Generate key'}
                  </Button>
                )}
              </div>

              <div className="mt-4 pt-4 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">Allowed origins</p>
                {env.allowedOrigins.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None — all cross-origin SDK requests blocked.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {env.allowedOrigins.map((origin) => (
                      <span key={origin} className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-1 rounded font-mono">
                        {origin}
                        {isAdmin && (
                          <button
                            onClick={() => handleRemoveOrigin(env.id, origin)}
                            disabled={originBusy === env.id}
                            className="ml-1 text-muted-foreground hover:text-destructive leading-none"
                            aria-label={`Remove ${origin}`}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {isAdmin && (
                  <form onSubmit={(e) => handleAddOrigin(e, env.id)} className="flex gap-2 mt-2">
                    <Input
                      placeholder="https://example.com or *"
                      value={newOrigin[env.id] ?? ''}
                      onChange={(e) => setNewOrigin((prev) => ({ ...prev, [env.id]: e.target.value }))}
                      className="h-8 text-xs"
                    />
                    <Button type="submit" size="sm" disabled={originBusy === env.id || !newOrigin[env.id]?.trim()}>
                      Add
                    </Button>
                  </form>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RevealedKeyBanner({ apiKey, onDismiss }: { apiKey: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-amber-900">Copy your API key now</p>
          <p className="text-xs text-amber-700 mt-0.5">
            This key will not be shown again. Store it somewhere safe.
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="text-amber-600 hover:text-amber-900 text-lg leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono bg-white border border-amber-200 rounded px-3 py-2 break-all text-amber-900">
          {apiKey}
        </code>
        <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
