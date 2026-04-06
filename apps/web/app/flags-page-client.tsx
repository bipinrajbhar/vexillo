"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, Loader2, Plus, Search } from "lucide-react";

import CreateFlagForm from "@/app/components/create-flag-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type EnvironmentRef = { id: string; name: string; slug: string };

const PRIMARY_ENV_STORAGE_KEY = "vexillo.primary-environment-id";

function pickDefaultPrimaryEnvId(envs: EnvironmentRef[]) {
  if (envs.length === 0) return "";
  const prod = envs.find((e) => e.slug === "production" || e.slug === "prod");
  return (prod ?? envs[0]).id;
}

export type FlagsPageFlag = {
  id: string;
  name: string;
  key: string;
  description: string;
  createdAt: string;
  states: Record<string, boolean>;
};

export default function FlagsPageClient({
  initialFlags,
  initialEnvironments,
  isAdmin,
}: {
  initialFlags: FlagsPageFlag[];
  initialEnvironments: EnvironmentRef[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [isListPending, startListTransition] = React.useTransition();
  const [flags, setFlags] = React.useState(initialFlags);
  const [query, setQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [primaryEnvId, setPrimaryEnvId] = React.useState<string>(() =>
    pickDefaultPrimaryEnvId(initialEnvironments),
  );

  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  /** Drop-shadow on sticky column only while scrolled — signals overlap, not default chrome. */
  const [stickyEdgeShadow, setStickyEdgeShadow] = React.useState(false);

  const primaryEnv =
    initialEnvironments.find((e) => e.id === primaryEnvId) ?? initialEnvironments[0] ?? null;

  const syncStickyEdgeShadow = React.useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    setStickyEdgeShadow(el.scrollLeft > 1);
  }, []);

  React.useEffect(() => {
    setFlags(initialFlags);
  }, [initialFlags]);

  React.useEffect(() => {
    if (initialEnvironments.length === 0) return;
    try {
      const raw = localStorage.getItem(PRIMARY_ENV_STORAGE_KEY);
      if (raw && initialEnvironments.some((e) => e.id === raw)) {
        setPrimaryEnvId(raw);
      }
    } catch {
      /* ignore */
    }
  }, [initialEnvironments]);

  React.useEffect(() => {
    if (initialEnvironments.length === 0) return;
    if (!initialEnvironments.some((e) => e.id === primaryEnvId)) {
      setPrimaryEnvId(pickDefaultPrimaryEnvId(initialEnvironments));
    }
  }, [initialEnvironments, primaryEnvId]);

  React.useEffect(() => {
    if (!primaryEnvId) return;
    try {
      localStorage.setItem(PRIMARY_ENV_STORAGE_KEY, primaryEnvId);
    } catch {
      /* ignore */
    }
  }, [primaryEnvId]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flags;
    return flags.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q),
    );
  }, [flags, query]);

  React.useLayoutEffect(() => {
    syncStickyEdgeShadow();
  }, [syncStickyEdgeShadow, filtered.length, initialEnvironments.length, primaryEnv?.id]);

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
  }, [syncStickyEdgeShadow]);

  async function handleCreate(data: {
    name: string;
    key: string;
    description: string;
  }) {
    const res = await fetch("/api/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.error === "string" ? err.error : "Failed to create flag");
    }
    setCreateOpen(false);
    startListTransition(() => {
      router.refresh();
    });
  }

  const listIsEmpty = !query.trim() && filtered.length === 0;

  return (
    <div className="page-container page-container-wide flex flex-1 flex-col">
      <header className="page-enter mb-8 flex flex-col gap-6 lg:mb-10 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="min-w-0 max-w-2xl">
          <h1 className="page-title">Feature flags</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Toggle features on or off per environment. Click a flag to manage its rollout.
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
              New flag
            </Button>
          </div>
        ) : null}
      </header>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          className="max-h-[min(90dvh,720px)] overflow-y-auto sm:max-w-lg"
          showCloseButton
        >
          <DialogHeader>
            <DialogTitle>New flag</DialogTitle>
            <DialogDescription>
              Starts off in all environments. Enable it per environment from the flag's detail page.
            </DialogDescription>
          </DialogHeader>
          <CreateFlagForm onSubmit={handleCreate} onCancel={() => setCreateOpen(false)} />
        </DialogContent>
      </Dialog>

      <div className="page-enter page-enter-delay-1 mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5 sm:gap-y-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-md">
          <Label htmlFor="flag-search" className="text-xs font-medium text-muted-foreground">
            Search
          </Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="flag-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search flags…"
              className="h-9 rounded-lg ps-10 shadow-xs"
              aria-label="Filter by name, key, or description"
            />
          </div>
        </div>
        {initialEnvironments.length > 0 ? (
          <div className="flex w-full min-w-48 flex-col gap-1.5 sm:w-auto sm:max-w-[16rem]">
            <Label htmlFor="primary-env" className="text-xs font-medium text-muted-foreground">
              Status in
            </Label>
            <select
              id="primary-env"
              className={cn(
                "h-9 w-full cursor-pointer rounded-lg border border-input bg-background px-3 text-sm shadow-xs",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
              value={primaryEnv?.id ?? ""}
              onChange={(e) => setPrimaryEnvId(e.target.value)}
              aria-label="Environment that controls the On / Off badge in each row"
            >
              {initialEnvironments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {initialEnvironments.length === 0 ? (
        <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>Add an environment first</AlertTitle>
          <AlertDescription className="mt-2 block space-y-4">
            <span className="block">
              You need at least one environment to use flags. Add one first.
            </span>
            {isAdmin ? (
              <Button className="w-full sm:w-auto" onClick={() => router.push("/environments")}>
                Open environments
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : query.trim() && filtered.length === 0 ? (
        <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No results</AlertTitle>
          <AlertDescription>
            No flags match your search.
          </AlertDescription>
        </Alert>
      ) : listIsEmpty && isListPending ? (
        <div
          className="page-enter page-enter-delay-2 flex flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-muted/25 py-16 text-center"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading flags"
        >
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Refreshing…</p>
        </div>
      ) : listIsEmpty ? (
        <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No flags yet</AlertTitle>
          <AlertDescription className="mt-2 block space-y-4">
            <span className="block">Create a flag to see it listed here.</span>
            {isAdmin ? (
              <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
                New flag
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : primaryEnv ? (
        <div
          className={cn(
            "table-shell page-enter page-enter-delay-2 transition-opacity duration-200",
            isListPending && "pointer-events-none opacity-55",
          )}
          aria-busy={isListPending}
        >
          <Table ref={tableScrollRef} className="data-table data-table-comfy">
            <TableHeader>
              <TableRow className="data-table-head-row">
                <TableHead
                  className={cn(
                    "data-table-th data-table-sticky-flag sticky left-0 z-30 min-w-[220px] border-r border-border ps-5 transition-shadow duration-200 ease-out",
                    stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                  )}
                >
                  Flag
                </TableHead>
                <TableHead
                  scope="col"
                  className="data-table-th w-[1%] whitespace-normal text-center font-normal"
                >
                  <span className="sr-only">Enabled in {primaryEnv.name}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((flag) => {
                const enabledCount = initialEnvironments.filter(
                  (e) => flag.states[e.slug],
                ).length;
                const envTotal = initialEnvironments.length;

                const on = flag.states[primaryEnv.slug] ?? false;

                return (
                  <TableRow key={flag.key} className="group/flag data-table-body-row">
                    <TableCell
                      className={cn(
                        "data-table-sticky-flag sticky left-0 z-20 min-w-0 border-r border-border align-top transition-[box-shadow,background-color] duration-200 ease-out group-hover/flag:bg-muted/50 ps-5",
                        stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                      )}
                    >
                      <Link
                        href={`/flags/${encodeURIComponent(flag.key)}`}
                        className="group/link block min-w-0 py-0.5"
                        title={
                          [flag.name, flag.key !== flag.name ? flag.key : null, flag.description.trim() || null]
                            .filter(Boolean)
                            .join(" — ") || undefined
                        }
                      >
                        <div className="data-table-cell-stack">
                          <span className="data-table-primary-label group-hover/link:text-primary">
                            {flag.name}
                          </span>
                          <code className="data-table-mono-meta">{flag.key}</code>
                        </div>
                        {flag.description.trim() ? (
                          <p className="mt-2 max-w-[22rem] line-clamp-2 text-[0.8125rem] leading-snug text-muted-foreground">
                            {flag.description.trim()}
                          </p>
                        ) : null}
                        {envTotal > 0 ? (
                          <p
                            className="mt-2 text-[0.6875rem] tabular-nums tracking-wide text-muted-foreground"
                            title={`Enabled in ${enabledCount} of ${envTotal} environments`}
                          >
                            <span className="font-medium text-foreground">{enabledCount}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="font-medium text-foreground">{envTotal}</span>
                            <span className="ms-1 text-muted-foreground">enabled</span>
                          </p>
                        ) : null}
                      </Link>
                    </TableCell>
                    <TableCell className="w-[1%] whitespace-nowrap text-center align-middle">
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums",
                          on
                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-50"
                            : "border-border bg-muted/30 text-muted-foreground",
                        )}
                      >
                        {on ? "On" : "Off"}
                      </Badge>
                    </TableCell>
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
            {query.trim() ? (
              <>
                <span className="font-medium text-foreground">{filtered.length}</span>
                {filtered.length === 1 ? " match" : " matches"}
                <span className="text-muted-foreground"> · </span>
                <span className="font-medium text-foreground">{flags.length}</span>
                {flags.length === 1 ? " flag" : " flags"} total
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{flags.length}</span>
                {flags.length === 1 ? " flag" : " flags"} total
              </>
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
