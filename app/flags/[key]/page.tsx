'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

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

  const [flag, setFlag] = useState<Flag | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

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

  function startEditing() {
    if (!flag) return;
    setEditName(flag.name);
    setEditDescription(flag.description);
    setEditError('');
    setEditing(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!flag) return;
    setSaving(true);
    setEditError('');
    try {
      const res = await fetch(`/api/flags/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, description: editDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.error ?? 'Failed to save');
        return;
      }
      setFlag((prev) => prev ? { ...prev, name: data.flag.name, description: data.flag.description } : prev);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

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
          <form onSubmit={handleSave} className="space-y-4 border rounded-lg p-6 bg-card">
            {editError && (
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                {editError}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
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
            <Button variant="outline" size="sm" onClick={startEditing}>Edit</Button>
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
                disabled={toggling === env.id}
                onCheckedChange={() => handleToggle(env)}
                aria-label={`Toggle ${flag.name} in ${env.name}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
