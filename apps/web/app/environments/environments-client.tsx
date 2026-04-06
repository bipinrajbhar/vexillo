"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Info,
  Loader2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const keyHintClassName =
  "block min-w-0 truncate font-mono text-[0.8125rem] font-normal tabular-nums text-muted-foreground";

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
          <span className="text-sm text-muted-foreground">—</span>
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
                  <TooltipContent side="top">Remove</TooltipContent>
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
          {saving ? "Saving…" : ""}
        </span>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>Add origin</DialogTitle>
            <DialogDescription>
              Enter an origin like <span className="font-mono text-[0.8rem]">https://app.example.com</span>.{" "}
              Use <code className="rounded bg-muted px-1 py-px font-mono text-[0.8rem]">*</code> to
              allow all origins — only if you mean it.
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
  const secretFieldRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    setSecretCopied(false);
    if (copyResetRef.current) {
      clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [secretDialog]);

  React.useEffect(() => {
    if (!secretDialog) return;
    const id = requestAnimationFrame(() => {
      const el = secretFieldRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(id);
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

  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const [stickyEdgeShadow, setStickyEdgeShadow] = React.useState(false);

  const syncStickyEdgeShadow = React.useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    setStickyEdgeShadow(el.scrollLeft > 1);
  }, []);

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

  React.useLayoutEffect(() => {
    syncStickyEdgeShadow();
  }, [syncStickyEdgeShadow, environments.length, isAdmin]);

  React.useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncStickyEdgeShadow());
    ro.observe(el);
    el.addEventListener("scroll", syncStickyEdgeShadow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", syncStickyEdgeShadow);
    };
  }, [syncStickyEdgeShadow, environments.length]);

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

  function flashCopied() {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    setSecretCopied(true);
    copyResetRef.current = setTimeout(() => {
      setSecretCopied(false);
      copyResetRef.current = null;
    }, 2000);
  }

  async function copySecret() {
    if (!secretDialog) return;
    try {
      await navigator.clipboard.writeText(secretDialog);
      flashCopied();
      return;
    } catch {
      // Clipboard API can fail (permissions, non-secure context). Fall back to selection + execCommand.
    }
    const el = secretFieldRef.current;
    if (el) {
      try {
        el.focus();
        el.select();
        const ok = document.execCommand("copy");
        if (ok) flashCopied();
        else setSecretCopied(false);
      } catch {
        setSecretCopied(false);
      }
    } else {
      setSecretCopied(false);
    }
  }

  return (
    <div className="page-container page-container-wide flex min-w-0 flex-1 flex-col pb-16">
      <header className="page-enter mb-8 flex flex-col gap-6 lg:mb-10 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="min-w-0 max-w-2xl">
          <p className="page-eyebrow">Keys &amp; CORS</p>
          <h1 className="page-title mt-1">Environments</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Each environment has an API key and a CORS allowlist. The full key is shown once — right after you create or rotate it.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex shrink-0">
            <Button
              type="button"
              size="lg"
              className="w-full gap-2 sm:w-auto"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" aria-hidden />
              New environment
            </Button>
          </div>
        ) : null}
      </header>

      {isAdmin ? (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogContent showCloseButton>
                <DialogHeader>
                  <DialogTitle>New environment</DialogTitle>
                  <DialogDescription>
                    The API key is shown once after creation — copy it somewhere safe.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="env-name">Name</Label>
                    <Input
                      id="env-name"
                      value={newEnvName}
                      onChange={(e) => setNewEnvName(e.target.value)}
                      placeholder="e.g. Production"
                      className="rounded-lg shadow-xs"
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

      <Dialog open={!!secretDialog} onOpenChange={(o) => !o && setSecretDialog(null)}>
        <DialogContent className="gap-5 sm:max-w-xl" showCloseButton>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-balance tracking-tight">Copy your API key</DialogTitle>
            <DialogDescription className="text-pretty leading-snug">
              This is the only time you'll see the full key. After closing, only a masked preview is shown. Rotate the key any time from the table.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="env-api-key-secret" className="sr-only">
              API key
            </Label>
            <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:bg-muted/25 dark:shadow-none">
              <Input
                ref={secretFieldRef}
                id="env-api-key-secret"
                readOnly
                value={secretDialog ?? ""}
                title={secretDialog ?? undefined}
                aria-readonly="true"
                spellCheck={false}
                autoComplete="off"
                className="h-8 min-w-0 overflow-x-auto border-0 bg-transparent px-0 font-mono text-[0.8125rem] leading-normal tracking-[-0.01em] shadow-none ring-0 selection:bg-foreground/12 focus-visible:ring-0 dark:bg-transparent md:text-sm"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-3 [&>*:first-child]:text-muted-foreground">
            <Button type="button" variant="ghost" onClick={() => setSecretDialog(null)}>
              Done
            </Button>
            <Button
              type="button"
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
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {environments.length === 0 ? (
        <Alert className="page-enter page-enter-delay-1 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No environments yet</AlertTitle>
          <AlertDescription>
            {isAdmin
              ? "Create one to get an API key and manage allowed origins."
              : "Only an admin can create environments, keys, and allowlists."}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="table-shell page-enter page-enter-delay-2">
          <Table ref={tableScrollRef} className="data-table data-table-comfy">
            <TableHeader>
              <TableRow className="data-table-head-row">
                <TableHead
                  className={cn(
                    "data-table-th data-table-sticky-flag sticky left-0 z-30 min-w-[200px] border-r border-border ps-5 transition-shadow duration-200 ease-out",
                    stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                  )}
                >
                  Environment
                </TableHead>
                <TableHead className="data-table-th hidden min-w-36 md:table-cell">
                  Key preview
                </TableHead>
                <TableHead className="data-table-th min-w-0">
                  Allowed origins (CORS)
                </TableHead>
                {isAdmin ? (
                  <TableHead className="data-table-th w-[1%] whitespace-nowrap pe-5 text-end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((env) => {
                const originRows = originRowsFor(env.id, env.allowedOrigins);
                return (
                  <TableRow key={env.id} className="group/env data-table-body-row">
                    <TableCell
                      className={cn(
                        "data-table-sticky-flag sticky left-0 z-20 min-w-0 border-r border-border align-top transition-[box-shadow,background-color] duration-200 ease-out group-hover/env:bg-muted/50 ps-5",
                        stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                      )}
                    >
                      <div className="min-w-0 py-0.5">
                        <div
                          className="data-table-cell-stack"
                          title={`${env.name} — ${env.slug}`}
                        >
                          <div className="data-table-primary-label">{env.name}</div>
                          <code className="data-table-mono-meta">{env.slug}</code>
                        </div>
                        {env.keyHint ? (
                          <code
                            className={cn(
                              keyHintClassName,
                              "mt-1.5 text-[0.7rem] text-muted-foreground/90 md:hidden",
                            )}
                            title={env.keyHint}
                          >
                            {env.keyHint}
                          </code>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-[min(100%,18rem)] whitespace-normal md:table-cell md:align-top">
                      {env.keyHint ? (
                        <code className={cn(keyHintClassName, "py-1")} title={env.keyHint}>
                          {env.keyHint}
                        </code>
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
                      <TableCell className="w-[1%] whitespace-nowrap align-top pe-5">
                        <div className="flex justify-end py-0.5">
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto gap-1.5 px-0 font-medium"
                            disabled={rotateBusy === env.id}
                            onClick={() => void rotateKey(env.id)}
                          >
                            {rotateBusy === env.id ? (
                              <>
                                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                                Rotating…
                              </>
                            ) : (
                              <>
                                <RotateCw className="size-3.5 shrink-0 opacity-70" aria-hidden />
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
          <p
            role="status"
            className="border-t border-border px-4 py-3 text-end text-xs tabular-nums text-muted-foreground sm:px-5"
            aria-live="polite"
          >
            <span className="font-medium text-foreground">{environments.length}</span>
            {environments.length === 1 ? " environment" : " environments"}
          </p>
        </div>
      )}
    </div>
  );
}
