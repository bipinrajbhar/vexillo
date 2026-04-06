"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmFlagToggleDialog } from "@/components/confirm-flag-toggle-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type FlagRolloutRow = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
};

export default function FlagDetailClient({
  flagKey,
  initialFlag,
  initialRollout,
  isAdmin,
}: {
  flagKey: string;
  initialFlag: {
    id: string;
    name: string;
    key: string;
    description: string;
  };
  initialRollout: FlagRolloutRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(initialFlag.name);
  const [description, setDescription] = React.useState(initialFlag.description);
  const [rollout, setRollout] = React.useState(initialRollout);
  const [savingMeta, setSavingMeta] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [toggleBusy, setToggleBusy] = React.useState<string | null>(null);
  const [confirmToggle, setConfirmToggle] = React.useState<null | {
    envId: string;
    envName: string;
    currentEnabled: boolean;
    nextEnabled: boolean;
  }>(null);
  const [confirmBusy, setConfirmBusy] = React.useState(false);

  React.useEffect(() => {
    setName(initialFlag.name);
    setDescription(initialFlag.description);
  }, [initialFlag]);

  React.useEffect(() => {
    setRollout(initialRollout);
  }, [initialRollout]);

  const isDirty = React.useMemo(
    () =>
      name.trim() !== initialFlag.name.trim() ||
      description.trim() !== initialFlag.description.trim(),
    [name, description, initialFlag.name, initialFlag.description],
  );

  function discardChanges() {
    setName(initialFlag.name);
    setDescription(initialFlag.description);
  }

  async function saveMeta() {
    setSavingMeta(true);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail =
          typeof err.error === "string"
            ? err.error
            : `Could not save (${res.status}). Try again.`;
        toast.error(detail);
        return;
      }
      toast.success("Changes saved");
      router.refresh();
    } finally {
      setSavingMeta(false);
    }
  }

  async function performToggle(environmentId: string): Promise<boolean> {
    const busyKey = `${flagKey}:${environmentId}`;
    setToggleBusy(busyKey);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}/toggle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environmentId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail =
          typeof err.error === "string"
            ? err.error
            : `Could not update flag (${res.status}). Try again.`;
        toast.error(detail);
        return false;
      }
      const { enabled } = (await res.json()) as { enabled: boolean };
      setRollout((prev) =>
        prev.map((r) => (r.id === environmentId ? { ...r, enabled } : r)),
      );
      return true;
    } finally {
      setToggleBusy(null);
    }
  }

  async function confirmDelete() {
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail =
          typeof err.error === "string"
            ? err.error
            : `Could not delete (${res.status}). Try again.`;
        toast.error(detail);
        return;
      }
      setDeleteOpen(false);
      router.push("/");
      router.refresh();
    } finally {
      setDeleteBusy(false);
    }
  }

  const displayTitle = (isAdmin ? name.trim() : initialFlag.name.trim()) || initialFlag.name;
  const envOnCount = rollout.filter((r) => r.enabled).length;
  const envTotal = rollout.length;

  const rolloutSection = (
    <div
      className={cn(
        "table-shell page-enter mb-6",
        isAdmin ? "page-enter-delay-1" : "page-enter-delay-2",
      )}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b border-border bg-muted/20 px-5 py-3 sm:px-6 dark:bg-muted/10">
        <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">Rollout</h2>
        {envTotal > 0 ? (
          <p className="text-sm tabular-nums text-muted-foreground">
            <span className="font-medium text-foreground">{envOnCount}</span>
            <span className="text-muted-foreground"> of </span>
            <span className="font-medium text-foreground">{envTotal}</span>
            <span className="text-muted-foreground"> enabled</span>
          </p>
        ) : null}
      </div>
      {rollout.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground sm:px-6">
          No environments yet.{" "}
          <Link href="/environments" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>{" "}
          to enable per-environment toggles.
        </p>
      ) : (
        <Table className="data-table data-table-comfy">
          <TableHeader>
            <TableRow className="data-table-head-row">
              <TableHead className="data-table-th">Environment</TableHead>
              <TableHead scope="col" className="data-table-th text-end font-normal">
                <span className="sr-only">Toggle flag in environment</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rollout.map((row) => {
              const busy = toggleBusy === `${flagKey}:${row.id}`;
              const dialogForThisRow =
                confirmToggle !== null && confirmToggle.envId === row.id;

              return (
                <TableRow key={row.id} className="group/flag data-table-body-row">
                  <TableCell className="max-w-md whitespace-normal">
                    <div className="data-table-cell-stack py-0.5">
                      <div className="data-table-primary-label">{row.name}</div>
                      <code className="data-table-mono-meta">{row.slug}</code>
                    </div>
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex items-center justify-end gap-2">
                      {isAdmin && busy ? (
                        <Loader2
                          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                          aria-hidden
                        />
                      ) : null}
                      <Switch
                        checked={row.enabled}
                        disabled={!isAdmin || busy || dialogForThisRow}
                        onCheckedChange={(next) =>
                          setConfirmToggle({
                            envId: row.id,
                            envName: row.name,
                            currentEnabled: row.enabled,
                            nextEnabled: next,
                          })
                        }
                        aria-label={
                          isAdmin
                            ? row.enabled
                              ? `Turn off ${displayTitle} in ${row.name}`
                              : `Turn on ${displayTitle} in ${row.name}`
                            : `${row.enabled ? "On" : "Off"} in ${row.name}`
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );

  const pageHero = (
    <header className="page-enter mb-6 max-w-3xl">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All flags
      </Link>
      <div className="mt-3 space-y-1.5">
        <h1 className="page-title text-balance">{displayTitle}</h1>
        <p className="font-mono text-[0.8125rem] leading-snug text-muted-foreground break-all">
          {initialFlag.key}
        </p>
        {!isAdmin ? (
          <p className="pt-1 text-sm leading-snug text-muted-foreground">
            {initialFlag.description?.trim()
              ? initialFlag.description.trim()
              : "No description yet."}
          </p>
        ) : null}
      </div>
    </header>
  );

  return (
    <div className="page-container page-container-wide flex min-w-0 flex-1 flex-col pb-10">
      {pageHero}

      {isAdmin ? (
        <>
          {rolloutSection}

          <Card className="surface-card page-enter mb-6 gap-0 overflow-hidden py-0 page-enter-delay-2">
            <CardHeader className="border-b border-border bg-muted/25 px-5 pb-2.5 pt-3 dark:bg-[rgb(255_255_255/0.04)]">
              <CardTitle className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
                Label &amp; notes
              </CardTitle>
              <CardDescription className="text-[0.8125rem] leading-snug text-muted-foreground">
                The flag key can't be changed. Everything else here is editable.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 px-5 pb-4 pt-3 sm:gap-5">
              {/*
                Row-synced grid on sm+: labels and fields align across columns.
                DOM order stacks on narrow screens (name block, then key block).
              */}
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                <Label
                  htmlFor="detail-name"
                  className="text-xs font-semibold text-foreground sm:col-start-1 sm:row-start-1"
                >
                  Name
                </Label>
                <Label className="text-xs font-semibold text-foreground sm:col-start-2 sm:row-start-1">
                  Key
                </Label>
                <div className="min-w-0 self-start sm:col-start-1 sm:row-start-2">
                  <Input
                    id="detail-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="off"
                    className={cn(
                      "h-11 w-full rounded-lg border-input/70 bg-muted/30 text-[0.9375rem] font-medium tracking-[-0.015em] shadow-none",
                      "transition-[color,background-color,border-color,box-shadow]",
                      "dark:border-white/10 dark:bg-[rgb(255_255_255/0.07)] dark:placeholder:text-muted-foreground",
                      "focus-visible:border-ring focus-visible:bg-background dark:focus-visible:bg-[rgb(255_255_255/0.09)]",
                    )}
                  />
                </div>
                <div
                  id="detail-key-display"
                  role="group"
                  aria-label="Flag key (read-only)"
                  className={cn(
                    "min-w-0 self-start rounded-lg border border-input/70 bg-muted/30 px-3 py-2 sm:col-start-2 sm:row-start-2 dark:border-white/10 dark:bg-[rgb(255_255_255/0.05)]",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]",
                  )}
                  title={initialFlag.key}
                >
                  <code className="block min-w-0 break-all font-mono text-[0.8125rem] leading-snug text-muted-foreground">
                    {initialFlag.key}
                  </code>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="detail-desc" className="text-xs font-semibold text-foreground">
                  Description
                </Label>
                <Textarea
                  id="detail-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="What this flag does, who owns it, any relevant links…"
                  className={cn(
                    "min-h-24 rounded-lg border-input/70 bg-muted/30 shadow-none",
                    "transition-[color,background-color,border-color,box-shadow]",
                    "dark:border-white/10 dark:bg-[rgb(255_255_255/0.07)]",
                    "focus-visible:border-ring focus-visible:bg-background dark:focus-visible:bg-[rgb(255_255_255/0.09)]",
                  )}
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col-reverse gap-2 border-t border-border bg-card px-5 py-3 shadow-none! sm:flex-row sm:justify-end sm:gap-3 dark:bg-card">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full sm:w-auto"
                disabled={!isDirty || savingMeta}
                onClick={() => discardChanges()}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                disabled={!isDirty || savingMeta}
                onClick={() => void saveMeta()}
              >
                {savingMeta ? "Saving…" : "Save"}
              </Button>
            </CardFooter>
          </Card>

          <Card className="page-enter page-enter-delay-3 border-destructive/25 bg-destructive/3 shadow-(--surface-shadow) dark:bg-destructive/6">
            <CardContent className="pt-5">
              <h3 className="text-sm font-semibold text-destructive">Delete flag</h3>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                Remove the flag from your code before deleting — otherwise flag checks may fail.
              </p>
              <Button
                type="button"
                variant="destructive"
                className="mt-3 gap-2"
                disabled={deleteBusy}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete flag
              </Button>
            </CardContent>
          </Card>

          <Dialog open={deleteOpen} onOpenChange={(o) => !deleteBusy && setDeleteOpen(o)}>
            <DialogContent showCloseButton className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Delete {displayTitle}?</DialogTitle>
                <DialogDescription className="text-pretty">
                  This can't be undone. All environment states for{" "}
                  <strong className="text-foreground">{displayTitle}</strong> will be deleted too.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={deleteBusy}
                  onClick={() => setDeleteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleteBusy}
                  onClick={() => void confirmDelete()}
                >
                  {deleteBusy ? "Deleting…" : "Delete flag"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <ConfirmFlagToggleDialog
            open={confirmToggle !== null}
            onOpenChange={(open) => {
              if (!open && !confirmBusy) setConfirmToggle(null);
            }}
            flagName={displayTitle}
            flagKey={initialFlag.key}
            environmentName={confirmToggle?.envName ?? ""}
            currentEnabled={confirmToggle?.currentEnabled ?? false}
            nextEnabled={confirmToggle?.nextEnabled ?? false}
            confirmBusy={confirmBusy}
            onConfirm={async () => {
              if (!confirmToggle) return;
              setConfirmBusy(true);
              try {
                const ok = await performToggle(confirmToggle.envId);
                if (ok) setConfirmToggle(null);
              } finally {
                setConfirmBusy(false);
              }
            }}
          />
        </>
      ) : (
        <>{rolloutSection}</>
      )}
    </div>
  );
}
