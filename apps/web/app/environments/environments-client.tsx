"use client";

import * as React from "react";
import { Check, Copy, Info, KeyRound, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type EnvironmentRow = {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  createdAt: string;
  keyHint: string | null;
};

function OriginAllowlistChips({
  envId,
  value,
  onChange,
  disabled,
  labelId,
}: {
  envId: string;
  value: string[];
  onChange: (origins: string[]) => void;
  disabled: boolean;
  labelId: string;
}) {
  const [composing, setComposing] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  function commitPiece(text: string) {
    const t = text.trim();
    if (!t) return;
    if (value.includes(t)) {
      setComposing("");
      return;
    }
    onChange([...value, t]);
    setComposing("");
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5",
        !disabled &&
          "cursor-text focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        disabled && "cursor-default bg-muted/15",
      )}
      onMouseDown={(e) => {
        if (disabled) return;
        const el = e.target as HTMLElement;
        if (el.tagName !== "INPUT" && !el.closest("button[type='button']")) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {value.map((origin, index) => (
        <span
          key={`${envId}-origin-${index}`}
          className="inline-flex max-w-[min(100%,26rem)] items-center gap-0.5 rounded-md border border-border/90 bg-muted/45 px-2 py-1 font-mono text-[0.6875rem] leading-tight text-foreground dark:bg-muted/30"
        >
          <span className="min-w-0 truncate" title={origin}>
            {origin}
          </span>
          {!disabled ? (
            <button
              type="button"
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              aria-label={`Remove ${origin}`}
            >
              <X className="size-3" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </span>
      ))}
      {!disabled ? (
        <input
          ref={inputRef}
          id={`origins-input-${envId}`}
          value={composing}
          onChange={(e) => setComposing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitPiece(composing);
              return;
            }
            if (e.key === "Backspace" && composing === "" && value.length > 0) {
              e.preventDefault();
              onChange(value.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain");
            if (/[,\n]/.test(text)) {
              e.preventDefault();
              const parts = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
              const seen = new Set(value);
              const merged = [...value];
              for (const p of parts) {
                if (!seen.has(p)) {
                  seen.add(p);
                  merged.push(p);
                }
              }
              onChange(merged);
              setComposing("");
            }
          }}
          onBlur={() => {
            if (composing.trim()) commitPiece(composing);
          }}
          className="min-h-6 min-w-40 flex-1 border-0 bg-transparent py-0.5 text-xs outline-none font-mono placeholder:text-muted-foreground"
          placeholder={
            value.length ? "Add another origin…" : "Type a URL, then Enter"
          }
          aria-label="Add allowed origin"
        />
      ) : value.length === 0 ? (
        <span className="py-0.5 text-sm text-muted-foreground">
          No origins in the allowlist.
        </span>
      ) : null}
    </div>
  );
}

export default function EnvironmentsClient({
  initialEnvironments,
  isAdmin,
}: {
  initialEnvironments: EnvironmentRow[];
  isAdmin: boolean;
}) {
  const [environments, setEnvironments] = React.useState(initialEnvironments);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newEnvName, setNewEnvName] = React.useState("");
  const [createBusy, setCreateBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState("");
  const [secretDialog, setSecretDialog] = React.useState<string | null>(null);
  const [secretCopied, setSecretCopied] = React.useState(false);
  const copyResetRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setSecretCopied(false);
    if (copyResetRef.current) {
      clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [secretDialog]);

  React.useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    },
    [],
  );
  const [originDrafts, setOriginDrafts] = React.useState<Record<string, string[]>>({});
  const [originBusy, setOriginBusy] = React.useState<string | null>(null);
  const [rotateBusy, setRotateBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEnvironments(initialEnvironments);
    setOriginDrafts((prev) => {
      const next = { ...prev };
      for (const e of initialEnvironments) {
        if (next[e.id] === undefined) {
          next[e.id] = [...e.allowedOrigins];
        }
      }
      return next;
    });
  }, [initialEnvironments]);

  function originRowsFor(id: string, fallback: string[]) {
    if (originDrafts[id] !== undefined) return originDrafts[id];
    return [...fallback];
  }

  function setOriginsList(envId: string, next: string[]) {
    setOriginDrafts((d) => ({ ...d, [envId]: next }));
  }

  async function refreshFromApi() {
    const res = await fetch("/api/environments");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.environments)) return;
    setEnvironments(
      data.environments.map((row: EnvironmentRow & { createdAt?: unknown }) => ({
        ...row,
        createdAt:
          typeof row.createdAt === "string"
            ? row.createdAt
            : new Date().toISOString(),
      })),
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setCreateBusy(true);
    try {
      const res = await fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newEnvName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(typeof data.error === "string" ? data.error : "Could not create environment");
        return;
      }
      const apiKey = typeof data.apiKey === "string" ? data.apiKey : null;
      setNewEnvName("");
      setCreateOpen(false);
      await refreshFromApi();
      if (apiKey) setSecretDialog(apiKey);
    } finally {
      setCreateBusy(false);
    }
  }

  async function saveOrigins(id: string) {
    const envRow = environments.find((e) => e.id === id);
    const list = originDrafts[id] ?? (envRow ? [...envRow.allowedOrigins] : []);
    const allowedOrigins = list.map((s) => s.trim()).filter(Boolean);
    setOriginBusy(id);
    try {
      const res = await fetch(`/api/environments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedOrigins }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { environment?: { allowedOrigins: string[] } };
      if (data.environment) {
        const nextOrigins = data.environment.allowedOrigins;
        setEnvironments((prev) =>
          prev.map((e) => (e.id === id ? { ...e, allowedOrigins: nextOrigins } : e)),
        );
        setOriginDrafts((d) => ({ ...d, [id]: [...nextOrigins] }));
      }
    } finally {
      setOriginBusy(null);
    }
  }

  async function rotateKey(id: string) {
    setRotateBusy(id);
    try {
      const res = await fetch(`/api/environments/${id}/rotate-key`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.apiKey === "string") {
        setSecretDialog(data.apiKey);
        await refreshFromApi();
      }
    } finally {
      setRotateBusy(null);
    }
  }

  async function copySecret() {
    if (!secretDialog) return;
    try {
      await navigator.clipboard.writeText(secretDialog);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      setSecretCopied(true);
      copyResetRef.current = setTimeout(() => {
        setSecretCopied(false);
        copyResetRef.current = null;
      }, 2000);
    } catch {
      setSecretCopied(false);
    }
  }

  return (
    <div className="page-container page-container-wide flex flex-1 flex-col pb-16">
      <header className="page-enter mb-8 md:mb-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-lg">
            <h1 className="page-title">Environments</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              SDK keys and CORS settings per environment. New keys are shown only once — copy them
              before closing the dialog.
            </p>
          </div>
          {isAdmin ? (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <Button type="button" className="shrink-0 gap-2" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Add environment
              </Button>
              <DialogContent showCloseButton>
                <DialogHeader>
                  <DialogTitle>New environment</DialogTitle>
                  <DialogDescription>
                    The slug is generated from the name. You will see the API key after creation.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="env-name">Name</Label>
                    <Input
                      id="env-name"
                      value={newEnvName}
                      onChange={(e) => setNewEnvName(e.target.value)}
                      placeholder="Production"
                      required
                    />
                  </div>
                  {createError ? (
                    <p className="text-sm text-destructive">{createError}</p>
                  ) : null}
                  <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createBusy}>
                      {createBusy ? "Creating…" : "Create"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </header>

      <Dialog open={!!secretDialog} onOpenChange={(o) => !o && setSecretDialog(null)}>
        <DialogContent className="sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>API key</DialogTitle>
            <DialogDescription>
              Copy and store it securely. Only a masked hint is kept in the dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-xs break-all text-foreground">
            {secretDialog}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              aria-label={secretCopied ? "Copied to clipboard" : "Copy API key"}
              onClick={() => void copySecret()}
            >
              {secretCopied ? (
                <>
                  <Check className="size-4" aria-hidden />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-4" aria-hidden />
                  Copy
                </>
              )}
            </Button>
            <Button type="button" onClick={() => setSecretDialog(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {environments.length === 0 ? (
        <Alert className="page-enter page-enter-delay-1 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No environments yet</AlertTitle>
          <AlertDescription>
            {isAdmin
              ? "Add an environment to get an API key."
              : "Ask an admin to add an environment."}
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2">
          {environments.map((env) => {
            const originRows = originRowsFor(env.id, env.allowedOrigins);
            return (
            <li key={env.id}>
              <Card className="surface-card h-full shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-lg">{env.name}</CardTitle>
                      <CardDescription className="mt-2 font-mono text-xs">
                        {env.slug}
                      </CardDescription>
                    </div>
                    {env.keyHint ? (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="font-mono text-xs text-muted-foreground">{env.keyHint}</span>
                      </div>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-5">
                  <div className="space-y-2">
                    <Label id={`origins-label-${env.id}`} className="block">
                      Allowed origins (CORS)
                    </Label>
                    <OriginAllowlistChips
                      envId={env.id}
                      value={originRows}
                      disabled={!isAdmin}
                      labelId={`origins-label-${env.id}`}
                      onChange={(next) => setOriginsList(env.id, next)}
                    />
                    <p className="text-xs text-muted-foreground">
                      One full origin per chip (scheme, host, port). Enter or comma adds a chip;
                      multi-line or CSV paste splits automatically. Duplicates are skipped. Save to
                      apply.
                    </p>
                  </div>
                  {isAdmin ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={originBusy === env.id}
                        onClick={() => void saveOrigins(env.id)}
                      >
                        {originBusy === env.id ? "Saving…" : "Save allowlist"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={rotateBusy === env.id}
                        onClick={() => void rotateKey(env.id)}
                      >
                        {rotateBusy === env.id ? "Rotating…" : "Rotate API key"}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
