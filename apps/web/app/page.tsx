'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import CreateFlagForm from './components/create-flag-form';
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

export default function FlagsPage() {
  const { data: sessionData } = authClient.useSession();
  const isAdmin = (sessionData?.user as { role?: string } | undefined)?.role === 'admin';

  const [flags, setFlags] = useState<Flag[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    const res = await fetch('/api/flags');
    const data = await res.json();
    setFlags(data.flags ?? []);
    setEnvironments(data.environments ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  async function handleCreate(data: { name: string; key: string; description: string }) {
    const res = await fetch('/api/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to create flag');
    }
    setShowForm(false);
    await fetchFlags();
  }

  async function handleDelete(key: string) {
    setDeletingKey(key);
    await fetch(`/api/flags/${key}`, { method: 'DELETE' });
    setDeletingKey(null);
    await fetchFlags();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Feature Flags</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {flags.length} flag{flags.length !== 1 ? 's' : ''}
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setShowForm((v) => !v)} variant={showForm ? 'outline' : 'default'}>
            {showForm ? 'Cancel' : 'New Flag'}
          </Button>
        )}
      </div>

      {showForm && (
        <div className="mb-8">
          <CreateFlagForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {flags.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-base mb-1">No flags yet</p>
          <p className="text-sm">Create your first flag to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                {environments.map((env) => (
                  <TableHead key={env.id} className="capitalize">{env.name}</TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => (
                <TableRow key={flag.id}>
                  <TableCell>
                    <Link
                      href={`/flags/${flag.key}`}
                      className="font-medium hover:underline"
                    >
                      {flag.name}
                    </Link>
                    {flag.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">
                        {flag.description}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {flag.key}
                  </TableCell>
                  {environments.map((env) => (
                    <TableCell key={env.id}>
                      {flag.states[env.slug] ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-600">On</Badge>
                      ) : (
                        <Badge variant="secondary">Off</Badge>
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(flag.key)}
                        disabled={deletingKey === flag.key}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {deletingKey === flag.key ? 'Deleting…' : 'Delete'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
