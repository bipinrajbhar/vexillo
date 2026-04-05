'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from '@tanstack/react-form';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authClient } from '@/lib/auth-client';

interface Environment {
  id: string;
  name: string;
  slug: string;
}

interface Flag {
  id: string;
  name: string;
  key: string;
  description: string;
  createdAt: string;
  states: Record<string, boolean>;
}

export default function FlagDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = use(params);
  const router = useRouter();
  const { data: sessionData } = authClient.useSession();
  const isAdmin = (sessionData?.user as { role?: string } | undefined)?.role === 'admin';

  const [flag, setFlag] = useState<Flag | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const fetchFlag = useCallback(async () => {
    const res = await fetch(`/api/flags/${key}`);
    if (res.status === 404) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setFlag(data.flag);
    setEnvironments(data.environments);
    setLoading(false);
  }, [key]);

  useEffect(() => {
    fetchFlag();
  }, [fetchFlag]);

  async function handleToggle(env: Environment) {
    if (!flag) return;
    setToggling(env.id);

    const currentState = flag.states[env.slug] ?? false;
    // Optimistic update
    setFlag((prev) =>
      prev
        ? { ...prev, states: { ...prev.states, [env.slug]: !currentState } }
        : prev,
    );

    const res = await fetch(`/api/flags/${key}/toggle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environmentId: env.id }),
    });

    if (res.ok) {
      const data = await res.json();
      setFlag((prev) =>
        prev
          ? { ...prev, states: { ...prev.states, [env.slug]: data.enabled } }
          : prev,
      );
    } else {
      // Revert on error
      setFlag((prev) =>
        prev
          ? { ...prev, states: { ...prev.states, [env.slug]: currentState } }
          : prev,
      );
    }

    setToggling(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (notFound || !flag) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-muted-foreground">Flag not found.</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => router.push('/')}>
          Back to flags
        </Button>
      </div>
    );
  }

  const createdAt = new Date(flag.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <div className="mb-8">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          ← Flags
        </Link>
      </div>

      <div className="mb-8">
        {editing ? (
          <FlagEditForm
            flagKey={key}
            initialName={flag.name}
            initialDescription={flag.description}
            onCancel={() => setEditing(false)}
            onSaved={(patch) => {
              setFlag((prev) => (prev ? { ...prev, ...patch } : prev));
              setEditing(false);
            }}
          />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{flag.name}</h1>
              <p className="font-mono text-sm text-muted-foreground mt-1">{flag.key}</p>
              {flag.description && (
                <p className="text-sm text-muted-foreground mt-2">{flag.description}</p>
              )}
              <p className="text-xs text-muted-foreground mt-3">Created {createdAt}</p>
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="rounded-md border divide-y">
        {environments.map((env) => {
          const enabled = flag.states[env.slug] ?? false;
          return (
            <div key={env.id} className="flex items-center justify-between px-4 py-4">
              <div>
                <p className="text-sm font-medium capitalize">{env.name}</p>
                <p className="text-xs text-muted-foreground font-mono">{env.slug}</p>
              </div>
              <Switch
                checked={enabled}
                disabled={!isAdmin || toggling === env.id}
                onCheckedChange={() => isAdmin && handleToggle(env)}
                aria-label={`Toggle ${flag.name} in ${env.name}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlagEditForm({
  flagKey,
  initialName,
  initialDescription,
  onCancel,
  onSaved,
}: {
  flagKey: string;
  initialName: string;
  initialDescription: string;
  onCancel: () => void;
  onSaved: (patch: { name: string; description: string }) => void;
}) {
  const [editError, setEditError] = useState('');

  const form = useForm({
    defaultValues: {
      name: initialName,
      description: initialDescription,
    },
    onSubmit: async ({ value }) => {
      setEditError('');
      const res = await fetch(`/api/flags/${flagKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name, description: value.description }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.error ?? 'Failed to save');
        return;
      }
      onSaved({ name: data.flag.name, description: data.flag.description });
    },
  });

  return (
    <form
      className="space-y-4 border rounded-lg p-6 bg-card"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      {editError && (
        <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
          {editError}
        </p>
      )}
      <form.Field name="name">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              required
              autoFocus
            />
          </div>
        )}
      </form.Field>
      <form.Field name="description">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
            />
          </div>
        )}
      </form.Field>
      <div className="flex gap-3">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save'}
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
