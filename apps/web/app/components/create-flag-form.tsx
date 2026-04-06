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
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      {submitError ? (
        <p className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <div className="space-y-5">
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
                placeholder="e.g. Dark mode checkout"
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
                placeholder="dark-mode-checkout"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Auto-filled from the name. Can't be changed after the flag is created.
              </p>
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
                rows={3}
                placeholder="What this flag does, who owns it, any relevant links…"
              />
            </div>
          )}
        </form.Field>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create flag'}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
