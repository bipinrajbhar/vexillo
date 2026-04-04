'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface Props {
  onSubmit: (data: { name: string; key: string; description: string }) => Promise<void>;
  onCancel: () => void;
}

export default function CreateFlagForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    if (!keyEdited) setKey(slugify(value));
  }

  function handleKeyChange(value: string) {
    setKey(value);
    setKeyEdited(value !== slugify(name));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), key: key.trim(), description: description.trim() });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border rounded-lg p-6 space-y-4 bg-card">
      <h2 className="font-semibold">Create Flag</h2>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="flag-name">Name</Label>
        <Input
          id="flag-name"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          required
          autoFocus
          placeholder="My New Feature"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="flag-key">Key</Label>
        <Input
          id="flag-key"
          value={key}
          onChange={(e) => handleKeyChange(e.target.value)}
          required
          placeholder="my-new-feature"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">Auto-generated from name. Immutable after creation.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="flag-description">Description</Label>
        <Textarea
          id="flag-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What does this flag control?"
        />
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Flag'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
