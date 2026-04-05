'use client';

import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
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
  const [keyEdited, setKeyEdited] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const form = useForm({
    defaultValues: {
      name: '',
      key: '',
      description: '',
    },
    onSubmit: async ({ value }) => {
      setSubmitError('');
      try {
        await onSubmit({
          name: value.name.trim(),
          key: value.key.trim(),
          description: value.description.trim(),
        });
      } catch (err: unknown) {
        setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
      }
    },
  });

  return (
    <form
      className="border rounded-lg p-6 space-y-4 bg-card"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <h2 className="font-semibold">Create Flag</h2>

      {submitError && (
        <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
          {submitError}
        </p>
      )}

      <form.Field name="name">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="flag-name">Name</Label>
            <Input
              id="flag-name"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => {
                const v = e.target.value;
                field.handleChange(v);
                if (!keyEdited) {
                  form.setFieldValue('key', slugify(v));
                }
              }}
              required
              autoFocus
              placeholder="My New Feature"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="key">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="flag-key">Key</Label>
            <Input
              id="flag-key"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => {
                const v = e.target.value;
                field.handleChange(v);
                setKeyEdited(v !== slugify(form.getFieldValue('name')));
              }}
              required
              placeholder="my-new-feature"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Auto-generated from name. Immutable after creation.</p>
          </div>
        )}
      </form.Field>

      <form.Field name="description">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="flag-description">Description</Label>
            <Textarea
              id="flag-description"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={2}
              placeholder="What does this flag control?"
            />
          </div>
        )}
      </form.Field>

      <div className="flex gap-3">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Flag'}
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
