"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Info,
  KeyRound,
  Loader2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type EnvironmentRow = {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  createdAt: string;
  keyHint: string | null;
};

function KeyHintChip({ hint }: { hint: string }) {
  return (
    <Badge
      variant="secondary"
      className="h-auto max-w-full min-w-0 gap-1.5 py-1 pr-2.5 pl-2 font-mono text-[0.6875rem] font-normal tabular-nums"
    >
      <KeyRound className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 truncate" title={hint}>
        {hint}
      </span>
    </Badge>
  );
}

const originChipBadgeClass =
  "h-auto max-w-[min(100%,26rem)] min-h-6 gap-1 py-0.5 pl-2 font-mono text-[0.6875rem] font-normal whitespace-normal";

function OriginAllowlistChips({
  envId,
  value,
  onChange,
  disabled,
  labelId,
  saving,
}: {
  envId: string;
  value: string[];
  onChange: (origins: string[]) => void;
  disabled: boolean;
  labelId: string;
  saving: boolean;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  React.useEffect(() => {
    if (!addOpen) setDraft("");
  }, [addOpen]);

  function commitDraft() {
    const next = draft.trim();
    if (!next) return;
    if (value.includes(next)) {
      setDraft("");
      return;
    }
    onChange([...value, next]);
    setAddOpen(false);
  }

  const isEmpty = value.length === 0;

  return (
    <div className="min-w-0 space-y-2">
      <div
        role="group"
        aria-labelledby={labelId}
        className="relative flex w-full min-w-0 max-w-full flex-wrap items-center gap-2"
      >
        {isEmpty && disabled ? (
          <span className="text-sm text-muted-foreground">No origins in the allowlist.</span>
        ) : null}
        {isEmpty && !disabled ? (
          <span className="text-sm text-muted-foreground">No origins yet.</span>
        ) : null}
        {value.map((origin, index) => {
          const isWildcard = origin === "*";
          return (
            <Badge
              key={`${envId}-origin-${index}`}
              variant={isWildcard ? "outline" : "secondary"}
              className={cn(
                originChipBadgeClass,
                "pr-0.5",
                isWildcard &&
                  "border-amber-500/45 bg-amber-500/12 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/12 dark:text-amber-50",
              )}
            >
              <span className="min-w-0 truncate py-0.5" title={origin}>
                {origin}
              </span>
              {!disabled ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={saving}
                        className="size-6 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onChange(value.filter((_, i) => i !== index))}
                        aria-label={`Remove ${origin}`}
                      />
                    }
                  >
                    <X className="size-3" strokeWidth={2} aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent side="top">Remove origin</TooltipContent>
                </Tooltip>
              ) : null}
            </Badge>
          );
        })}
        {!disabled ? (
          <span className="inline-flex items-center gap-1.5">
            <Badge
              variant="secondary"
              render={
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setAddOpen(true)}
                  className="cursor-pointer outline-none disabled:pointer-events-none disabled:opacity-40"
                />
              }
              className={cn(
                originChipBadgeClass,
                "pr-2.5 text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <Plus className="size-3 shrink-0 opacity-80" aria-hidden />
              Add origin
            </Badge>
            {saving ? (
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : null}
          </span>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {saving ? "Saving allowlist…" : ""}
        </span>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>Add origin</DialogTitle>
            <DialogDescription>
              Full URL (scheme, host, and port when non-default).{" "}
              <code className="rounded bg-muted px-1 py-px font-mono text-[0.8rem]">*</code> is open
              CORS. Skips duplicates; changes save on their own.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`origins-add-${envId}`}>Origin</Label>
            <Input
              id={`origins-add-${envId}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://app.example.com"
              className="font-mono text-sm"
              autoComplete="off"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!draft.trim()} onClick={() => commitDraft()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const originPersistTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const originPendingRef = React.useRef<Record<string, string[]>>({});

  React.useEffect(
    () => () => {
      for (const t of Object.values(originPersistTimersRef.current)) {
        clearTimeout(t);
      }
    },
    [],
  );

  React.useEffect(() => {
    setEnvironments(initialEnvironments);
    setOriginDrafts(
      Object.fromEntries(initialEnvironments.map((e) => [e.id, [...e.allowedOrigins]])),
    );
  }, [initialEnvironments]);

  function originRowsFor(id: string, fallback: string[]) {
    if (originDrafts[id] !== undefined) return originDrafts[id];
    return [...fallback];
  }

  function setOriginsList(envId: string, next: string[]) {
    originPendingRef.current[envId] = next;
    setOriginDrafts((d) => ({ ...d, [envId]: next }));
    const prevT = originPersistTimersRef.current[envId];
    if (prevT) clearTimeout(prevT);
    originPersistTimersRef.current[envId] = setTimeout(() => {
      delete originPersistTimersRef.current[envId];
      const list = originPendingRef.current[envId];
      if (list) void persistOrigins(envId, list);
    }, 400);
  }

  async function refreshFromApi() {
    const res = await fetch("/api/environments");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.environments)) return;
    const mapped = data.environments.map((row: EnvironmentRow & { createdAt?: unknown }) => ({
      ...row,
      createdAt:
        typeof row.createdAt === "string"
          ? row.createdAt
          : new Date().toISOString(),
    }));
    setEnvironments(mapped);
    setOriginDrafts(Object.fromEntries(mapped.map((e: EnvironmentRow) => [e.id, [...e.allowedOrigins]])));
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

  async function persistOrigins(id: string, list: string[]) {
    const allowedOrigins = list.map((s) => s.trim()).filter(Boolean);
    setOriginBusy(id);
    try {
      const res = await fetch(`/api/environments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedOrigins }),
      });
      if (!res.ok) {
        await refreshFromApi();
        return;
      }
      const data = (await res.json()) as { environment?: { allowedOrigins: string[] } };
      if (data.environment) {
        const nextOrigins = data.environment.allowedOrigins;
        setEnvironments((prev) =>
          prev.map((e) => (e.id === id ? { ...e, allowedOrigins: nextOrigins } : e)),
        );
        setOriginDrafts((d) => ({ ...d, [id]: [...nextOrigins] }));
        originPendingRef.current[id] = [...nextOrigins];
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
    <div className="page-container page-container-wide flex min-w-0 flex-1 flex-col pb-16">
      <header className="page-enter mb-8 md:mb-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-lg">
            <p className="page-eyebrow">Access control</p>
            <h1 className="page-title mt-1">Environments</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              SDK keys and per-environment browser origins. New keys show once in a dialog — copy them
              before closing.
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
          <Card className="gap-0 border-0 bg-transparent py-0 shadow-none">
            <CardContent className="rounded-lg border border-border/80 bg-muted/30 px-4 py-3.5 font-mono text-xs leading-relaxed break-all dark:bg-muted/15">
              {secretDialog}
            </CardContent>
          </Card>
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
        <Card className="page-enter page-enter-delay-1 gap-0 overflow-hidden py-0 shadow-sm">
          <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-48 ps-5 font-medium text-foreground">
                  Environment
                </TableHead>
                <TableHead className="hidden min-w-36 font-medium text-foreground md:table-cell">
                  Key hint
                </TableHead>
                <TableHead className="min-w-0 font-medium text-foreground">
                  Allowed origins (CORS)
                </TableHead>
                {isAdmin ? (
                  <TableHead className="w-[1%] whitespace-nowrap pe-5 text-end font-medium text-foreground">
                    Actions
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((env) => {
                const originRows = originRowsFor(env.id, env.allowedOrigins);
                return (
                  <TableRow
                    key={env.id}
                    className="transition-colors hover:bg-muted/20 dark:hover:bg-muted/10"
                  >
                    <TableCell className="min-w-0 whitespace-normal ps-5 align-top">
                      <div className="min-w-0 py-1">
                        <div className="text-[0.9375rem] font-medium tracking-[-0.01em] text-foreground">
                          {env.name}
                        </div>
                        <code className="mt-1 block font-mono text-[0.7rem] text-muted-foreground/90">
                          {env.slug}
                        </code>
                        {env.keyHint ? (
                          <div className="mt-3 md:hidden">
                            <KeyHintChip hint={env.keyHint} />
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-normal md:table-cell md:align-top">
                      {env.keyHint ? (
                        <KeyHintChip hint={env.keyHint} />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-0 max-w-xl whitespace-normal align-top">
                      <div className="min-w-0 space-y-2 py-1">
                        <Label id={`origins-label-${env.id}`} className="sr-only">
                          Allowed origins for {env.name}
                        </Label>
                        <OriginAllowlistChips
                          envId={env.id}
                          value={originRows}
                          disabled={!isAdmin}
                          saving={originBusy === env.id}
                          labelId={`origins-label-${env.id}`}
                          onChange={(next) => setOriginsList(env.id, next)}
                        />
                      </div>
                    </TableCell>
                    {isAdmin ? (
                      <TableCell className="whitespace-normal align-top pe-5">
                        <div className="flex justify-end py-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={rotateBusy === env.id}
                            onClick={() => void rotateKey(env.id)}
                          >
                            {rotateBusy === env.id ? (
                              <>
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                Rotating…
                              </>
                            ) : (
                              <>
                                <RotateCw className="size-3.5 opacity-70" aria-hidden />
                                Rotate key
                              </>
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
