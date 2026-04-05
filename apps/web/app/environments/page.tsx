'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from '@tanstack/react-form';
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
  const [rotating, setRotating] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
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

  async function patchOrigins(envId: string, origins: string[]): Promise<boolean> {
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
        return true;
      }
      return false;
    } finally {
      setOriginBusy(null);
    }
  }

  async function addOrigin(envId: string, origin: string): Promise<boolean> {
    const trimmed = origin.trim();
    if (!trimmed) return false;
    const env = environments.find((e) => e.id === envId);
    if (!env || env.allowedOrigins.includes(trimmed)) return false;
    return patchOrigins(envId, [...env.allowedOrigins, trimmed]);
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
          <Button onClick={() => setShowForm((v) => !v)} variant={showForm ? 'outline' : 'default'}>
            {showForm ? 'Cancel' : 'New Environment'}
          </Button>
        )}
      </div>

      {showForm && (
        <CreateEnvironmentForm
          className="mb-8"
          onCreated={async (data) => {
            setShowForm(false);
            setRevealedKey({ environmentId: data.environmentId, apiKey: data.apiKey });
            await fetchEnvironments();
          }}
          onCancel={() => setShowForm(false)}
        />
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
                  <AddOriginForm
                    envId={env.id}
                    disabled={originBusy === env.id}
                    onAdd={addOrigin}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateEnvironmentForm({
  className,
  onCreated,
  onCancel,
}: {
  className?: string;
  onCreated: (data: { environmentId: string; apiKey: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [createError, setCreateError] = useState('');

  const form = useForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      setCreateError('');
      const res = await fetch('/api/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error ?? 'Failed to create environment');
        return;
      }
      form.reset();
      await onCreated({ environmentId: data.environment.id, apiKey: data.apiKey });
    },
  });

  return (
    <form
      className={['border rounded-lg p-6 space-y-4 bg-card', className].filter(Boolean).join(' ')}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <h2 className="font-semibold">Create Environment</h2>
      {createError && (
        <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
          {createError}
        </p>
      )}
      <form.Field name="name">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="env-name">Name</Label>
            <Input
              id="env-name"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              required
              autoFocus
              placeholder="QA"
            />
          </div>
        )}
      </form.Field>
      <div className="flex gap-3">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Environment'}
            </Button>
          )}
        </form.Subscribe>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddOriginForm({
  envId,
  disabled,
  onAdd,
}: {
  envId: string;
  disabled: boolean;
  onAdd: (envId: string, origin: string) => Promise<boolean>;
}) {
  const form = useForm({
    defaultValues: { origin: '' },
    onSubmit: async ({ value }) => {
      const added = await onAdd(envId, value.origin);
      if (added) form.reset();
    },
  });

  return (
    <form
      className="flex gap-2 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="origin">
        {(field) => (
          <Input
            placeholder="https://example.com or *"
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={(e) => field.handleChange(e.target.value)}
            className="h-8 text-xs"
          />
        )}
      </form.Field>
      <form.Subscribe selector={(s) => s.values.origin.trim()}>
        {(trimmed) => (
          <Button type="submit" size="sm" disabled={disabled || !trimmed}>
            Add
          </Button>
        )}
      </form.Subscribe>
    </form>
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
